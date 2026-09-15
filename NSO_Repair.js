/* NSO_Repair.js — standalone non-manifold repair for triangle soup.
 *
 * Classic script. No module system, no dependencies, no DOM. Attaches a single
 * object to `window` and touches nothing else, so it can be loaded next to the
 * app without being wired into it.
 *
 *   window.NSO_Repair.commit(rawTris, options) -> { rawTris, report, ok }
 *
 * `rawTris` in and out is the app's raw triangle soup: a flat Float32Array of
 * 9 floats per triangle (three xyz vertices, CCW-outward winding). The returned
 * array is a NEW Float32Array when anything was applied, and the CALLER'S OWN
 * array (same reference) when nothing was applied, so "unchanged" is checkable
 * by identity as well as by value.
 *
 * Fail-safe contract. Every path out of commit() returns the caller's input
 * untouched unless a repair both ran and passed the gate. An internal throw is
 * caught and reported as ok:false with the input handed straight back; the
 * caller can always use `result.rawTris` regardless of `ok`.
 *
 * NOT wired into the app. See docs/NSO_Repair.md for scope and known limits.
 */
(function (global) {
  'use strict';

  var VERSION = 'NSO_Repair/1.0.0';

  /* Vertex weld radius, in model units (mm). Two vertices closer than this are
   * the same vertex. 1e-4 mm is four orders of magnitude below the smallest
   * feature any printable mesh carries, and still resolvable in float32 out to
   * roughly 5000 mm. See docs/NSO_Repair.md "Tolerance budget". */
  var WELD_TOL = 1e-4;

  /* On-edge tolerance for T-junction detection, in model units (mm). A vertex
   * within this distance of another triangle's edge interior is treated as
   * lying on that edge. Deliberately ~50x WELD_TOL: a T-junction is a topology
   * error, not a precision error, and the stray vertex can sit visibly off the
   * edge. Survives a Float32Array round-trip at every tested scale. */
  var SPLIT_EPS = 5e-3;

  /* Pinch separation moves each duplicated vertex copy this fraction of its
   * own fan's mean incident edge length, toward that fan's centroid. */
  var NUDGE_FRAC = 0.02;

  /* Refuse to fan a boundary loop longer than this. Long loops are not holes,
   * they are missing geometry, and a fan across one is a guess. */
  var MAX_HOLE_EDGES = 64;

  /* Flap peeling is iterative; these bound the damage it can do. */
  var MAX_PEEL_ROUNDS = 16;
  var MAX_PEEL_FRACTION = 0.10;

  /* A component with no boundary is a closed shell. An open component at or
   * below this share of the triangle budget, next to a closed shell, is debris. */
  var ORPHAN_MAX_FRACTION = 0.01;
  var ORPHAN_MAX_TRIS = 4;

  /* ------------------------------------------------------------------ *
   * Small math helpers
   * ------------------------------------------------------------------ */

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len(a) { return Math.sqrt(dot(a, a)); }

  function dist2(ax, ay, az, bx, by, bz) {
    var dx = ax - bx, dy = ay - by, dz = az - bz;
    return dx * dx + dy * dy + dz * dz;
  }

  /* ------------------------------------------------------------------ *
   * Mesh: { pos: [x,y,z,...], faces: [a,b,c,...] }
   * ------------------------------------------------------------------ */

  function cloneMesh(m) {
    return { pos: m.pos.slice(), faces: m.faces.slice() };
  }

  function faceCount(m) { return m.faces.length / 3; }

  function vtx(m, i) { return [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]]; }

  /* Weld a raw soup into an indexed mesh. Grid hash at cell size `tol`, with a
   * 27-cell neighbourhood search so a pair straddling a cell boundary still
   * welds. */
  function weldToIndexed(rawTris, tol) {
    var n = Math.floor(rawTris.length / 9) * 3; // vertex slots
    var pos = [];
    var faces = new Array(n);
    var cells = Object.create(null);
    var inv = 1 / tol;
    var tol2 = tol * tol;
    var collapsed = 0;
    var collapsedNear = 0;

    for (var s = 0; s < n; s++) {
      var x = rawTris[s * 3], y = rawTris[s * 3 + 1], z = rawTris[s * 3 + 2];
      var ci = Math.floor(x * inv), cj = Math.floor(y * inv), ck = Math.floor(z * inv);
      var found = -1, foundD2 = 0;
      for (var di = -1; di <= 1 && found < 0; di++) {
        for (var dj = -1; dj <= 1 && found < 0; dj++) {
          for (var dk = -1; dk <= 1 && found < 0; dk++) {
            var bucket = cells[(ci + di) + ',' + (cj + dj) + ',' + (ck + dk)];
            if (!bucket) continue;
            for (var b = 0; b < bucket.length; b++) {
              var vi = bucket[b];
              var d2 = dist2(x, y, z, pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
              if (d2 <= tol2) { found = vi; foundD2 = d2; break; }
            }
          }
        }
      }
      if (found < 0) {
        found = pos.length / 3;
        pos.push(x, y, z);
        var key = ci + ',' + cj + ',' + ck;
        if (!cells[key]) cells[key] = [];
        cells[key].push(found);
      } else {
        collapsed++;
        /* An exactly-equal slot is just how a triangle soup stores a shared
         * corner. A slot that is merely CLOSE is a defect the weld repaired,
         * and only that kind counts as a change. */
        if (foundD2 > 0) collapsedNear++;
      }
      faces[s] = found;
    }
    return { mesh: { pos: pos, faces: faces }, collapsed: collapsed, collapsedNear: collapsedNear };
  }

  function toRaw(m) {
    var out = new Float32Array(m.faces.length * 3);
    for (var f = 0; f < m.faces.length; f++) {
      var v = m.faces[f] * 3;
      out[f * 3] = m.pos[v];
      out[f * 3 + 1] = m.pos[v + 1];
      out[f * 3 + 2] = m.pos[v + 2];
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Topology
   * ------------------------------------------------------------------ */

  function ekey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }

  /* Undirected edge -> { count, faces:[], fwd, rev }. `fwd` counts directed
   * uses low->high, `rev` counts high->low; a consistently wound closed shell
   * has count 2 with fwd 1 and rev 1 on every edge. */
  function buildEdges(m) {
    var edges = Object.create(null);
    var nf = faceCount(m);
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      var tri = [[a, b], [b, c], [c, a]];
      for (var e = 0; e < 3; e++) {
        var u = tri[e][0], v = tri[e][1];
        var k = ekey(u, v);
        var rec = edges[k];
        if (!rec) { rec = edges[k] = { count: 0, faces: [], fwd: 0, rev: 0, a: Math.min(u, v), b: Math.max(u, v) }; }
        rec.count++;
        rec.faces.push(f);
        if (u < v) rec.fwd++; else rec.rev++;
      }
    }
    return edges;
  }

  function signedVolume(m) {
    var vol = 0, nf = faceCount(m);
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3] * 3, b = m.faces[f * 3 + 1] * 3, c = m.faces[f * 3 + 2] * 3;
      var ax = m.pos[a], ay = m.pos[a + 1], az = m.pos[a + 2];
      var bx = m.pos[b], by = m.pos[b + 1], bz = m.pos[b + 2];
      var cx = m.pos[c], cy = m.pos[c + 1], cz = m.pos[c + 2];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx));
    }
    return vol / 6;
  }

  function surfaceArea(m) {
    var area = 0, nf = faceCount(m);
    for (var f = 0; f < nf; f++) {
      var A = vtx(m, m.faces[f * 3]), B = vtx(m, m.faces[f * 3 + 1]), C = vtx(m, m.faces[f * 3 + 2]);
      area += 0.5 * len(cross(sub(B, A), sub(C, A)));
    }
    return area;
  }

  function triArea(m, f) {
    var A = vtx(m, m.faces[f * 3]), B = vtx(m, m.faces[f * 3 + 1]), C = vtx(m, m.faces[f * 3 + 2]);
    return 0.5 * len(cross(sub(B, A), sub(C, A)));
  }

  /* Edge-connected components over faces. */
  function components(m, edges) {
    var nf = faceCount(m);
    var comp = new Array(nf);
    for (var i = 0; i < nf; i++) comp[i] = -1;
    var adj = new Array(nf);
    for (i = 0; i < nf; i++) adj[i] = [];
    for (var k in edges) {
      var fs = edges[k].faces;
      for (var x = 0; x < fs.length; x++) {
        for (var y = x + 1; y < fs.length; y++) { adj[fs[x]].push(fs[y]); adj[fs[y]].push(fs[x]); }
      }
    }
    var groups = [];
    for (var s = 0; s < nf; s++) {
      if (comp[s] >= 0) continue;
      var id = groups.length, stack = [s], list = [];
      comp[s] = id;
      while (stack.length) {
        var f = stack.pop();
        list.push(f);
        var nb = adj[f];
        for (var j = 0; j < nb.length; j++) if (comp[nb[j]] < 0) { comp[nb[j]] = id; stack.push(nb[j]); }
      }
      groups.push(list);
    }
    return { comp: comp, groups: groups };
  }

  /* Vertices whose incident triangle fan falls into more than one group — the
   * places where two or more otherwise separate sheets meet at a point.
   *
   * This catches both shapes of pinch, because both come out as a split fan:
   *
   *   bowtie vertex — two sheets touching at one point and sharing no edge at
   *   all, so the fans were never connected in the first place.
   *
   *   non-manifold edge — three or more faces along one edge. The fan at each
   *   endpoint is split because fanGroups refuses to join faces across such an
   *   edge (see there). Splitting every vertex along the run separates the
   *   sheets coherently: each sheet keeps its own copy of both endpoints, so
   *   the edge between those copies ends up used by that sheet alone. */
  function pinchVertices(m, edges) {
    if (!edges) edges = buildEdges(m);
    var nf = faceCount(m);
    var incident = Object.create(null);
    for (var f = 0; f < nf; f++) {
      for (var i = 0; i < 3; i++) {
        var v = m.faces[f * 3 + i];
        if (!incident[v]) incident[v] = [];
        incident[v].push(f);
      }
    }
    var out = [];
    for (var vs in incident) {
      var v0 = +vs, fs = incident[v0];
      if (fs.length < 2) continue;
      var groups = fanGroups(m, v0, fs, edges);
      if (groups.length > 1) out.push({ v: v0, faces: fs, groups: groups });
    }
    return out;
  }

  /* Partition the faces around vertex v into fans: two faces are in the same fan
   * when they share an edge that has v as an endpoint AND that edge is
   * manifold.
   *
   * The manifold qualifier is what makes a non-manifold edge visible here. An
   * edge used by three or more faces does not join those faces into one
   * surface — it is the seam where separate sheets happen to coincide — so
   * treating it as a connection would merge every sheet into a single fan and
   * hide the defect. A boundary edge needs no special case: it has exactly one
   * face, so there is nothing for it to join. */
  function fanGroups(m, v, fs, edges) {
    var index = Object.create(null);
    for (var i = 0; i < fs.length; i++) index[fs[i]] = i;
    var parent = new Array(fs.length);
    for (i = 0; i < fs.length; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }

    var spoke = Object.create(null); // other endpoint of an edge at v -> face slots
    for (i = 0; i < fs.length; i++) {
      var f = fs[i];
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      var others = [];
      if (a === v) { others.push(b, c); } else if (b === v) { others.push(c, a); } else { others.push(a, b); }
      for (var o = 0; o < others.length; o++) {
        var key = others[o];
        var rec = edges[ekey(v, key)];
        if (rec && rec.count > 2) continue; // seam, not a connection
        if (!spoke[key]) spoke[key] = [];
        spoke[key].push(i);
      }
    }
    for (var s in spoke) {
      var list = spoke[s];
      for (var j = 1; j < list.length; j++) union(list[0], list[j]);
    }
    var byRoot = Object.create(null);
    for (i = 0; i < fs.length; i++) {
      var r = find(i);
      if (!byRoot[r]) byRoot[r] = [];
      byRoot[r].push(fs[i]);
    }
    var out = [];
    for (var r2 in byRoot) out.push(byRoot[r2]);
    return out;
  }

  /* Directed boundary loops. Each loop is a vertex cycle; a patch closing it
   * must be wound the other way round. */
  function boundaryLoops(m, edges) {
    var nf = faceCount(m);
    var starts = Object.create(null); // vertex -> [to,...]
    var total = 0;
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      var tri = [[a, b], [b, c], [c, a]];
      for (var e = 0; e < 3; e++) {
        var u = tri[e][0], v = tri[e][1];
        if (edges[ekey(u, v)].count !== 1) continue;
        if (!starts[u]) starts[u] = [];
        starts[u].push(v);
        total++;
      }
    }
    var loops = [];
    var used = 0;
    while (used < total) {
      var from = null;
      for (var k in starts) { if (starts[k].length) { from = +k; break; } }
      if (from === null) break;
      var loop = [from], cur = from, guard = 0;
      while (guard++ < total + 4) {
        var nexts = starts[cur];
        if (!nexts || !nexts.length) { loop = null; break; }
        var nxt = nexts.pop();
        used++;
        if (nxt === from) break;
        loop.push(nxt);
        cur = nxt;
      }
      if (loop && loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  /* ------------------------------------------------------------------ *
   * Self-intersection (Möller interval-overlap + coplanar SAT)
   *
   * CANONICAL — this is a transcription of tools/mesh_validate.py, which is
   * the single source of truth for the policy. Do not change one without the
   * other: tools/nso_selfint_equiv_test.js asserts the two agree pair-for-pair
   * on every fixture in the repo, and fails if they drift. The four policy
   * axes and the measurements that settled them are written out in that file's
   * module docstring.
   *
   * Returns 'pierce', 'coplanar', or null. The repair gate counts piercing
   * only — see countSelfIntersections.
   * ------------------------------------------------------------------ */

  var SELFINT_EPS = 1e-9;

  /* Do two coplanar triangles overlap with positive area? Dropped to 2D on the
   * plane's dominant axis, then separating-axis over all six edge normals.
   * Separation is strict, so triangles that merely share an edge or touch at a
   * point have a separating axis and correctly do NOT overlap — which is what
   * makes a coplanar count mean anything at a boolean seam, and what retires
   * the objection in docs/NSO_Repair.md that a cheap coplanar test
   * false-positives on ordinary adjacent geometry. */
  function coplanarOverlap(T1, T2, N, eps) {
    var drop = 0, mx = Math.abs(N[0]);
    if (Math.abs(N[1]) > mx) { mx = Math.abs(N[1]); drop = 1; }
    if (Math.abs(N[2]) > mx) { drop = 2; }
    var ax = (drop + 1) % 3, ay = (drop + 2) % 3;
    var A = [[T1[0][ax], T1[0][ay]], [T1[1][ax], T1[1][ay]], [T1[2][ax], T1[2][ay]]];
    var B = [[T2[0][ax], T2[0][ay]], [T2[1][ax], T2[1][ay]], [T2[2][ax], T2[2][ay]]];
    var polys = [A, B];
    for (var pi = 0; pi < 2; pi++) {
      var poly = polys[pi];
      for (var i = 0; i < 3; i++) {
        var x0 = poly[i][0], y0 = poly[i][1];
        var x1 = poly[(i + 1) % 3][0], y1 = poly[(i + 1) % 3][1];
        var nx = -(y1 - y0), ny = (x1 - x0);
        var L = Math.sqrt(nx * nx + ny * ny);
        if (L < 1e-18) continue;
        nx /= L; ny /= L;
        var paMin = Infinity, paMax = -Infinity, pbMin = Infinity, pbMax = -Infinity;
        for (var k = 0; k < 3; k++) {
          var da = nx * A[k][0] + ny * A[k][1];
          if (da < paMin) paMin = da;
          if (da > paMax) paMax = da;
          var db = nx * B[k][0] + ny * B[k][1];
          if (db < pbMin) pbMin = db;
          if (db > pbMax) pbMax = db;
        }
        if (paMax <= pbMin + eps || pbMax <= paMin + eps) return false;
      }
    }
    return true;
  }

  function triTriIntersect(V0, V1, V2, U0, U1, U2) {
    var EPS = SELFINT_EPS;
    var T1 = [V0, V1, V2], T2 = [U0, U1, U2];

    /* Plane distances are divided by the normal's length, so EPS is a distance
     * in mm and means the same for a 5e-3 mm sliver as for an 80 mm face.
     * Without the division the test is not even symmetric — a sliver's
     * unnormalised normal is tiny, so distances measured against ITS plane get
     * zeroed while the same pair measured the other way round does not, and
     * the answer then depends on the order the broad phase visited the pair
     * in. See tools/mesh_validate.py tri_tri_intersect for the tape-fixture
     * pair that exposed it. Interval arithmetic below is unaffected: it uses
     * only ratios of distances, and the normalisation cancels. */
    var N1 = cross(sub(V1, V0), sub(V2, V0));
    var N2 = cross(sub(U1, U0), sub(U2, U0));
    var L1 = Math.sqrt(dot(N1, N1)), L2 = Math.sqrt(dot(N2, N2));
    if (L1 <= 0 || L2 <= 0) return null;            // degenerate, counted apart

    var d1 = -dot(N1, V0);
    var du0 = (dot(N1, U0) + d1) / L1, du1 = (dot(N1, U1) + d1) / L1,
        du2 = (dot(N1, U2) + d1) / L1;
    if (Math.abs(du0) < EPS) du0 = 0;
    if (Math.abs(du1) < EPS) du1 = 0;
    if (Math.abs(du2) < EPS) du2 = 0;
    var du0du1 = du0 * du1, du0du2 = du0 * du2;
    if (du0du1 > 0 && du0du2 > 0) return null;      // tri2 entirely one side

    var d2 = -dot(N2, U0);
    var dv0 = (dot(N2, V0) + d2) / L2, dv1 = (dot(N2, V1) + d2) / L2,
        dv2 = (dot(N2, V2) + d2) / L2;
    if (Math.abs(dv0) < EPS) dv0 = 0;
    if (Math.abs(dv1) < EPS) dv1 = 0;
    if (Math.abs(dv2) < EPS) dv2 = 0;
    var dv0dv1 = dv0 * dv1, dv0dv2 = dv0 * dv2;
    if (dv0dv1 > 0 && dv0dv2 > 0) return null;      // tri1 entirely one side

    /* |N1 x N2| / (|N1||N2|) is the sine of the angle between the planes, so
     * this cutoff is an angle, not a size. Only the SAME plane can overlap,
     * and only then if the two actually share area — being coplanar is not by
     * itself a defect, so it is tested, not assumed. */
    var D = cross(N1, N2);
    var max = Math.abs(D[0]), index = 0;
    var bb = Math.abs(D[1]), cc = Math.abs(D[2]);
    if (bb > max) { max = bb; index = 1; }
    if (cc > max) { max = cc; index = 2; }

    if (max / (L1 * L2) < 1e-20) {
      if (Math.abs(dv0) > EPS || Math.abs(dv1) > EPS || Math.abs(dv2) > EPS) return null;
      return coplanarOverlap(T1, T2, N1, EPS) ? 'coplanar' : null;
    }

    var vp0 = V0[index], vp1 = V1[index], vp2 = V2[index];
    var up0 = U0[index], up1 = U1[index], up2 = U2[index];

    var isectV = isect2(vp0, vp1, vp2, dv0, dv1, dv2, dv0dv1, dv0dv2);
    var isectU = isect2(up0, up1, up2, du0, du1, du2, du0du1, du0du2);
    if (!isectV || !isectU) {
      return coplanarOverlap(T1, T2, N1, EPS) ? 'coplanar' : null;
    }

    if (isectV[0] > isectV[1]) isectV = [isectV[1], isectV[0]];
    if (isectU[0] > isectU[1]) isectU = [isectU[1], isectU[0]];

    /* Touching exactly at an interval endpoint is contact, not penetration.
     * The old test here was strict (`<` rather than `<= +EPS`), which called a
     * zero-overlap contact a pierce. STL coordinates are float32 — ULP 9.5e-7
     * at 8 mm — so an overlap that small is below what the file can represent.
     * See mesh_validate.py axis 3. */
    if (isectV[1] <= isectU[0] + EPS || isectU[1] <= isectV[0] + EPS) return null;
    return 'pierce';
  }

  function isect2(vv0, vv1, vv2, d0, d1, d2, d0d1, d0d2) {
    if (d0d1 > 0) return interval(vv2, vv0, vv1, d2, d0, d1);
    if (d0d2 > 0) return interval(vv1, vv0, vv2, d1, d0, d2);
    if (d1 * d2 > 0 || d0 !== 0) return interval(vv0, vv1, vv2, d0, d1, d2);
    if (d1 !== 0) return interval(vv1, vv0, vv2, d1, d0, d2);
    if (d2 !== 0) return interval(vv2, vv0, vv1, d2, d0, d1);
    return null; // coplanar
  }

  function interval(a, b, c, da, db, dc) {
    return [a + (b - a) * (da / (da - db)), a + (c - a) * (da / (da - dc))];
  }

  /* Counts intersecting triangle pairs. Triangles sharing a vertex index are
   * skipped: after welding, "sharing a vertex" is exactly adjacency.
   *
   * Broadphase is a median-split AABB tree rather than a uniform grid. Real
   * meshes mix triangle sizes badly — the tape fixture in this repo runs from
   * 5e-3 mm slivers up to a single 80 mm face — and at any grid pitch fine
   * enough for the slivers, one big triangle lands in tens of thousands of
   * cells. A tree does not care about the spread, and its self-traversal visits
   * each unordered pair at most once, so no pair-dedupe table is needed. */
  /* Piercing-pair count — the number the repair gate is tuned against.
   * docs/NSO_Repair.md records why coplanar overlap stays out of the gate: a
   * boolean seam produces legitimate coplanar contact, so folding it in would
   * refuse to repair meshes that are fine. countSelfIntersectionsDetail()
   * reports it alongside for callers that want the full picture. */
  function countSelfIntersections(m) {
    return countSelfIntersectionsDetail(m).pierce;
  }

  function countSelfIntersectionsDetail(m) {
    var nf = faceCount(m);
    if (nf < 2) return { pierce: 0, coplanar: 0 };

    var boxes = new Float64Array(nf * 6);
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3] * 3, b = m.faces[f * 3 + 1] * 3, c = m.faces[f * 3 + 2] * 3;
      for (var k = 0; k < 3; k++) {
        boxes[f * 6 + k] = Math.min(m.pos[a + k], m.pos[b + k], m.pos[c + k]);
        boxes[f * 6 + 3 + k] = Math.max(m.pos[a + k], m.pos[b + k], m.pos[c + k]);
      }
    }

    var tree = buildBVH(nf, boxes);
    var nodes = tree.nodes, order = tree.order;
    var tally = { pierce: 0, coplanar: 0 };

    // Pair stack. (i, i) means "this subtree against itself".
    var stack = [0, 0];
    while (stack.length) {
      var bi = stack.pop(), ai = stack.pop();
      var A = nodes[ai], B = nodes[bi];

      if (ai === bi) {
        if (A.leaf) {
          for (var x = A.start; x < A.start + A.count; x++) {
            for (var y = x + 1; y < A.start + A.count; y++) testPair(m, boxes, order[x], order[y], tally);
          }
        } else {
          stack.push(A.left, A.left, A.right, A.right, A.left, A.right);
        }
        continue;
      }

      if (!boxesOverlap(boxes, A, B)) continue;

      if (A.leaf && B.leaf) {
        for (var p = A.start; p < A.start + A.count; p++) {
          for (var q = B.start; q < B.start + B.count; q++) testPair(m, boxes, order[p], order[q], tally);
        }
        continue;
      }
      // Descend whichever side still has children, biggest first.
      if (B.leaf || (!A.leaf && nodeExtent(A) >= nodeExtent(B))) {
        stack.push(A.left, bi, A.right, bi);
      } else {
        stack.push(ai, B.left, ai, B.right);
      }
    }
    return tally;
  }

  function testPair(m, boxes, fa, fb, tally) {
    if (shareVertex(m, fa, fb)) return;
    /* Box reject with EPS of slack, matching mesh_validate.py. The slack has
     * to be here and not just in the narrow phase: a strict reject drops pairs
     * whose boxes are separated by less than EPS, and a coplanar pair that
     * touches within EPS in one axis can still overlap with real area in the
     * plane. Without it this file found 6 coplanar pairs on the tape fixture
     * where mesh_validate.py found 7. */
    for (var k = 0; k < 3; k++) {
      if (boxes[fa * 6 + 3 + k] < boxes[fb * 6 + k] - SELFINT_EPS) return;
      if (boxes[fb * 6 + 3 + k] < boxes[fa * 6 + k] - SELFINT_EPS) return;
    }
    var hit = triTriIntersect(vtx(m, m.faces[fa * 3]), vtx(m, m.faces[fa * 3 + 1]), vtx(m, m.faces[fa * 3 + 2]),
                              vtx(m, m.faces[fb * 3]), vtx(m, m.faces[fb * 3 + 1]), vtx(m, m.faces[fb * 3 + 2]));
    if (hit === 'pierce') tally.pierce++;
    else if (hit === 'coplanar') tally.coplanar++;
  }

  /* Node-level reject, and it carries the same EPS slack as the leaf-level one
   * in testPair. It has to: a node box that clears its neighbour by less than
   * EPS prunes the whole subtree, so a strict test here silently loses pairs
   * the narrow phase would have counted, and no amount of slack further down
   * gets them back. This cost one coplanar pair on the tape fixture (6 against
   * mesh_validate.py's 7) until the slack was added in both places. */
  function boxesOverlap(boxes, A, B) {
    for (var k = 0; k < 3; k++) {
      if (A.hi[k] < B.lo[k] - SELFINT_EPS || B.hi[k] < A.lo[k] - SELFINT_EPS) return false;
    }
    return true;
  }

  function nodeExtent(N) {
    return Math.max(N.hi[0] - N.lo[0], N.hi[1] - N.lo[1], N.hi[2] - N.lo[2]);
  }

  var BVH_LEAF = 8;

  function buildBVH(nf, boxes) {
    var order = new Int32Array(nf);
    for (var i = 0; i < nf; i++) order[i] = i;
    var nodes = [];
    var centroid = new Float64Array(nf * 3);
    for (i = 0; i < nf; i++) {
      for (var k = 0; k < 3; k++) centroid[i * 3 + k] = (boxes[i * 6 + k] + boxes[i * 6 + 3 + k]) * 0.5;
    }

    function build(start, count) {
      var idx = nodes.length;
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      var clo = [Infinity, Infinity, Infinity], chi = [-Infinity, -Infinity, -Infinity];
      for (var i = start; i < start + count; i++) {
        var f = order[i];
        for (var k = 0; k < 3; k++) {
          if (boxes[f * 6 + k] < lo[k]) lo[k] = boxes[f * 6 + k];
          if (boxes[f * 6 + 3 + k] > hi[k]) hi[k] = boxes[f * 6 + 3 + k];
          var c = centroid[f * 3 + k];
          if (c < clo[k]) clo[k] = c;
          if (c > chi[k]) chi[k] = c;
        }
      }
      var node = { lo: lo, hi: hi, start: start, count: count, leaf: true, left: -1, right: -1 };
      nodes.push(node);
      if (count <= BVH_LEAF) return idx;

      var axis = 0;
      if (chi[1] - clo[1] > chi[axis] - clo[axis]) axis = 1;
      if (chi[2] - clo[2] > chi[axis] - clo[axis]) axis = 2;
      if (!(chi[axis] - clo[axis] > 0)) return idx; // all centroids coincide

      var slice = [];
      for (i = start; i < start + count; i++) slice.push(order[i]);
      slice.sort(function (p, q) { return centroid[p * 3 + axis] - centroid[q * 3 + axis]; });
      for (i = 0; i < count; i++) order[start + i] = slice[i];

      var half = count >> 1;
      node.leaf = false;
      node.left = build(start, half);
      node.right = build(start + half, count - half);
      return idx;
    }

    build(0, nf);
    return { nodes: nodes, order: order };
  }

  function shareVertex(m, fa, fb) {
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) if (m.faces[fa * 3 + i] === m.faces[fb * 3 + j]) return true;
    }
    return false;
  }

  function boxOverlap(A, B) {
    return !(A[1][0] < B[0][0] || B[1][0] < A[0][0] ||
             A[1][1] < B[0][1] || B[1][1] < A[0][1] ||
             A[1][2] < B[0][2] || B[1][2] < A[0][2]);
  }

  /* ------------------------------------------------------------------ *
   * Metrics
   * ------------------------------------------------------------------ */

  function analyze(m, opts) {
    opts = opts || {};
    var edges = buildEdges(m);
    var open = 0, nonmanifold = 0, unique = 0, flipped = 0;
    for (var k in edges) {
      unique++;
      var rec = edges[k];
      if (rec.count === 1) open++;
      else if (rec.count > 2) nonmanifold++;
      else if (rec.fwd !== 1 || rec.rev !== 1) flipped++;
    }
    var nf = faceCount(m);
    var degenerate = 0;
    for (var f = 0; f < nf; f++) if (triArea(m, f) <= 1e-12) degenerate++;

    var comp = components(m, edges);
    var out = {
      tris: nf,
      verts: m.pos.length / 3,
      uniqueEdges: unique,
      openEdges: open,
      nonManifoldEdges: nonmanifold,
      oddEdges: open + nonmanifold,
      flippedEdges: flipped,
      degenerateTris: degenerate,
      components: comp.groups.length,
      boundaryLoops: boundaryLoops(m, edges).length,
      pinchVerts: pinchVertices(m, edges).length,
      volume: signedVolume(m),
      area: surfaceArea(m),
      watertight: (open + nonmanifold) === 0
    };
    if (opts.selfIntersections !== false) {
      var si = countSelfIntersectionsDetail(m);
      out.selfIntersections = si.pierce;
      out.selfIntersectionsCoplanar = si.coplanar;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Stage: degenerate triangles
   * ------------------------------------------------------------------ */

  function stripDegenerate(m) {
    var nf = faceCount(m), keep = [], removed = 0;
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      if (a === b || b === c || c === a || triArea(m, f) <= 1e-12) { removed++; continue; }
      keep.push(a, b, c);
    }
    m.faces = keep;
    return removed;
  }

  /* ------------------------------------------------------------------ *
   * Stage: duplicate faces (exact and reversed)
   * ------------------------------------------------------------------ */

  function stripDuplicateFaces(m) {
    var nf = faceCount(m);
    var groups = Object.create(null);
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      var s = [a, b, c].sort(function (p, q) { return p - q; });
      var key = s[0] + '_' + s[1] + '_' + s[2];
      if (!groups[key]) groups[key] = [];
      groups[key].push(f);
    }

    /* Directed-edge use counts from faces that are NOT in any duplicate group.
     * A consistently wound shell uses each directed edge once; the copy to keep
     * is the one that conflicts with the surrounding shell least. */
    var singles = Object.create(null);
    for (var key2 in groups) {
      if (groups[key2].length < 2) {
        var f2 = groups[key2][0];
        tallyDirected(singles, m, f2, 1);
      }
    }

    var exact = 0, reversed = 0;
    var drop = Object.create(null);
    for (var key3 in groups) {
      var g = groups[key3];
      if (g.length < 2) continue;
      var best = g[0], bestConflict = Infinity;
      for (var i = 0; i < g.length; i++) {
        var conflict = directedConflict(singles, m, g[i]);
        if (conflict < bestConflict) { bestConflict = conflict; best = g[i]; }
      }
      for (i = 0; i < g.length; i++) {
        if (g[i] === best) continue;
        drop[g[i]] = 1;
        if (sameWinding(m, g[i], best)) exact++; else reversed++;
      }
    }

    if (exact + reversed === 0) return { exact: 0, reversed: 0 };
    var keep = [];
    for (var f3 = 0; f3 < nf; f3++) {
      if (drop[f3]) continue;
      keep.push(m.faces[f3 * 3], m.faces[f3 * 3 + 1], m.faces[f3 * 3 + 2]);
    }
    m.faces = keep;
    return { exact: exact, reversed: reversed };
  }

  function tallyDirected(map, m, f, delta) {
    var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
    var pairs = [[a, b], [b, c], [c, a]];
    for (var i = 0; i < 3; i++) {
      var k = pairs[i][0] + '>' + pairs[i][1];
      map[k] = (map[k] || 0) + delta;
    }
  }

  /* How many of this face's directed edges are already used in the SAME
   * direction by the surrounding shell. A correctly wound face contributes the
   * opposite direction to each neighbour, so the right copy scores 0. */
  function directedConflict(map, m, f) {
    var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
    var pairs = [[a, b], [b, c], [c, a]];
    var n = 0;
    for (var i = 0; i < 3; i++) n += (map[pairs[i][0] + '>' + pairs[i][1]] || 0);
    return n;
  }

  function sameWinding(m, f, g) {
    var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
    var p = m.faces[g * 3], q = m.faces[g * 3 + 1], r = m.faces[g * 3 + 2];
    return (a === p && b === q && c === r) || (a === q && b === r && c === p) || (a === r && b === p && c === q);
  }

  /* ------------------------------------------------------------------ *
   * Stage: flap peel + orphan components
   * ------------------------------------------------------------------ */

  /* A flap is a triangle hanging off the shell: two or more of its edges are
   * used by nobody else. Peeling is iterative because removing one flap can
   * expose the next. */
  function peelFlaps(m) {
    var startCount = faceCount(m);
    var budget = Math.max(1, Math.floor(startCount * MAX_PEEL_FRACTION));
    var removed = 0;
    for (var round = 0; round < MAX_PEEL_ROUNDS; round++) {
      var edges = buildEdges(m);
      var nf = faceCount(m);
      var drop = Object.create(null), n = 0;
      for (var f = 0; f < nf; f++) {
        var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
        var bnd = 0;
        if (edges[ekey(a, b)].count === 1) bnd++;
        if (edges[ekey(b, c)].count === 1) bnd++;
        if (edges[ekey(c, a)].count === 1) bnd++;
        if (bnd >= 2) { drop[f] = 1; n++; }
      }
      if (!n) break;
      if (removed + n > budget) return { removed: removed, budgetHit: true };
      var keep = [];
      for (var f2 = 0; f2 < nf; f2++) {
        if (drop[f2]) continue;
        keep.push(m.faces[f2 * 3], m.faces[f2 * 3 + 1], m.faces[f2 * 3 + 2]);
      }
      m.faces = keep;
      removed += n;
    }
    return { removed: removed, budgetHit: false };
  }

  /* Detached open scraps sitting next to a closed shell. */
  function dropOrphanComponents(m) {
    var edges = buildEdges(m);
    var comp = components(m, edges);
    if (comp.groups.length < 2) return 0;

    var hasClosed = false;
    var closedFlags = [];
    for (var g = 0; g < comp.groups.length; g++) {
      var closed = componentIsClosed(m, comp.groups[g], edges);
      closedFlags.push(closed);
      if (closed) hasClosed = true;
    }
    if (!hasClosed) return 0;

    var nf = faceCount(m);
    var limit = Math.max(ORPHAN_MAX_TRIS, Math.floor(nf * ORPHAN_MAX_FRACTION));
    var drop = Object.create(null), removed = 0;
    for (g = 0; g < comp.groups.length; g++) {
      if (closedFlags[g]) continue;
      if (comp.groups[g].length > limit) continue;
      for (var i = 0; i < comp.groups[g].length; i++) { drop[comp.groups[g][i]] = 1; removed++; }
    }
    if (!removed) return 0;
    var keep = [];
    for (var f = 0; f < nf; f++) {
      if (drop[f]) continue;
      keep.push(m.faces[f * 3], m.faces[f * 3 + 1], m.faces[f * 3 + 2]);
    }
    m.faces = keep;
    return removed;
  }

  function componentIsClosed(m, faces, edges) {
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      if (edges[ekey(a, b)].count !== 2) return false;
      if (edges[ekey(b, c)].count !== 2) return false;
      if (edges[ekey(c, a)].count !== 2) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Stage: T-junctions
   * ------------------------------------------------------------------ */

  /* Vertices sitting on the interior of some other triangle's edge. Each such
   * vertex is inserted by splitting the offending triangle corner-to-point,
   * repeatedly, so no fan ever produces a sliver.
   *
   * Only cracked topology is considered. A T-junction is by definition a crack:
   * the long edge is used once, and the two short edges it should have been
   * split into are used once each. So the stray vertex and the edge it sits on
   * are both incident to an edge whose use count is not 2, and nothing else can
   * be a T-junction. Restricting the search that way keeps the stage off sound
   * geometry - a vertex that merely happens to lie on an edge of a properly
   * closed surface is not a crack, and splitting it there is meddling - and it
   * is also what makes the stage affordable: on a mostly healthy mesh the
   * candidate set is a handful of vertices instead of all of them. */
  function splitTJunctions(m, eps) {
    var eps2 = eps * eps;
    var edges = buildEdges(m);
    var nf0 = faceCount(m);

    var suspectVert = Object.create(null);
    var suspectCount = 0;
    for (var k in edges) {
      if (edges[k].count === 2) continue;
      var rec = edges[k];
      if (!suspectVert[rec.a]) { suspectVert[rec.a] = 1; suspectCount++; }
      if (!suspectVert[rec.b]) { suspectVert[rec.b] = 1; suspectCount++; }
    }
    if (!suspectCount) return { splits: 0, overflow: false };

    var cand = [];
    for (var vs in suspectVert) cand.push(+vs);

    // Grid over the candidate vertices only.
    var minx = Infinity, miny = Infinity, minz = Infinity;
    var maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (var i = 0; i < cand.length; i++) {
      var v = cand[i], x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    var span = Math.max(maxx - minx, maxy - miny, maxz - minz) || 1;
    var cell = Math.max(span / 32, eps * 4);
    var grid = Object.create(null);
    for (i = 0; i < cand.length; i++) {
      v = cand[i];
      var key = Math.floor((m.pos[v * 3] - minx) / cell) + ',' +
                Math.floor((m.pos[v * 3 + 1] - miny) / cell) + ',' +
                Math.floor((m.pos[v * 3 + 2] - minz) / cell);
      if (!grid[key]) grid[key] = [];
      grid[key].push(v);
    }

    function verticesNear(a, b) {
      var ax = m.pos[a * 3], ay = m.pos[a * 3 + 1], az = m.pos[a * 3 + 2];
      var bx = m.pos[b * 3], by = m.pos[b * 3 + 1], bz = m.pos[b * 3 + 2];
      var i0 = Math.floor((Math.min(ax, bx) - minx - eps) / cell);
      var i1 = Math.floor((Math.max(ax, bx) - minx + eps) / cell);
      var j0 = Math.floor((Math.min(ay, by) - miny - eps) / cell);
      var j1 = Math.floor((Math.max(ay, by) - miny + eps) / cell);
      var k0 = Math.floor((Math.min(az, bz) - minz - eps) / cell);
      var k1 = Math.floor((Math.max(az, bz) - minz + eps) / cell);
      var out = [];
      for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) for (var kk = k0; kk <= k1; kk++) {
        var bucket = grid[i + ',' + j + ',' + kk];
        if (bucket) for (var q = 0; q < bucket.length; q++) out.push(bucket[q]);
      }
      return out;
    }

    /* Parameter of p's projection on segment ab. Returns null when p is not
     * strictly inside the segment, or sits further off it than eps. */
    function onEdge(p, a, b) {
      var ax = m.pos[a * 3], ay = m.pos[a * 3 + 1], az = m.pos[a * 3 + 2];
      var ux = m.pos[b * 3] - ax, uy = m.pos[b * 3 + 1] - ay, uz = m.pos[b * 3 + 2] - az;
      var L2 = ux * ux + uy * uy + uz * uz;
      if (L2 <= 0) return null;
      var px = m.pos[p * 3] - ax, py = m.pos[p * 3 + 1] - ay, pz = m.pos[p * 3 + 2] - az;
      var t = (px * ux + py * uy + pz * uz) / L2;
      var L = Math.sqrt(L2);
      var margin = Math.max(eps, WELD_TOL) / L;
      if (t <= margin || t >= 1 - margin) return null;
      var dx = px - ux * t, dy = py - uy * t, dz = pz - uz * t;
      if (dx * dx + dy * dy + dz * dz > eps2) return null;
      return t;
    }

    /* Only faces that already own a cracked edge can carry a T-junction; the
     * rest go straight through untouched. */
    var outFaces = [];
    var queue = [];
    for (var f = 0; f < nf0; f++) {
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      if (edges[ekey(a, b)].count !== 2 || edges[ekey(b, c)].count !== 2 || edges[ekey(c, a)].count !== 2) {
        queue.push([a, b, c]);
      } else {
        outFaces.push(a, b, c);
      }
    }

    var splits = 0;
    var guard = 0, guardMax = queue.length * 64 + 4096;
    while (queue.length) {
      if (++guard > guardMax) return { splits: -1, overflow: true };
      var tri = queue.pop();
      a = tri[0]; b = tri[1]; c = tri[2];
      var sides = [[a, b, c], [b, c, a], [c, a, b]];
      var didSplit = false;
      for (var e = 0; e < 3 && !didSplit; e++) {
        var u = sides[e][0], w = sides[e][1], opp = sides[e][2];
        var near = verticesNear(u, w);
        var bestV = -1, bestT = 0;
        for (var q2 = 0; q2 < near.length; q2++) {
          var pv = near[q2];
          if (pv === a || pv === b || pv === c) continue;
          var t2 = onEdge(pv, u, w);
          if (t2 === null) continue;
          if (bestV < 0 || t2 < bestT) { bestV = pv; bestT = t2; }
        }
        if (bestV >= 0) {
          // corner-to-point split: never produces a sliver, unlike a fan
          queue.push([u, bestV, opp]);
          queue.push([bestV, w, opp]);
          splits++;
          didSplit = true;
        }
      }
      if (!didSplit) outFaces.push(a, b, c);
    }
    m.faces = outFaces;
    return { splits: splits, overflow: false };
  }

  /* ------------------------------------------------------------------ *
   * Stage: hole fill
   * ------------------------------------------------------------------ */

  /* `inputVertexCount` is the vertex count of the mesh as it arrived. Any loop
   * touching a vertex created since then was opened by an earlier stage of this
   * same repair — pinch separation is the only stage that adds vertices — and
   * closing it would be bridging our own seam, not filling a hole in the model.
   *
   * That distinction is the whole difference between repairing a mesh and
   * reshaping it. A sheet that touches itself along an edge gets separated by
   * the nudge and leaves a slit the width of the nudge; capping that slit
   * yields a watertight mesh with a neck whose width came from NUDGE_FRAC
   * rather than from the model. On Thingi10K 37825 that neck measures 0.1 mm
   * across — well under any nozzle, and invented. Refusing here leaves the slit
   * open, which the final odd-edge gate then sees, so the whole repair is
   * discarded and the file is returned untouched. Bridging a neck properly
   * means re-triangulating the neighbourhood at a chosen width; that is a
   * different operation and a different module. */
  function fillHoles(m, inputVertexCount) {
    var edges = buildEdges(m);
    var loops = boundaryLoops(m, edges);
    var filled = 0, added = 0, skipped = 0, selfMade = 0;
    for (var i = 0; i < loops.length; i++) {
      var loop = loops[i];
      if (inputVertexCount != null) {
        var ours = false;
        for (var n = 0; n < loop.length; n++) {
          if (loop[n] >= inputVertexCount) { ours = true; break; }
        }
        if (ours) { selfMade++; continue; }
      }
      if (loop.length > MAX_HOLE_EDGES) { skipped++; continue; }
      // Patch is wound opposite to the boundary walk.
      var rev = [loop[0]];
      for (var j = loop.length - 1; j >= 1; j--) rev.push(loop[j]);
      for (var k = 1; k + 1 < rev.length; k++) {
        m.faces.push(rev[0], rev[k], rev[k + 1]);
        added++;
      }
      filled++;
    }
    return { filled: filled, added: added, skipped: skipped, selfMade: selfMade };
  }

  /* ------------------------------------------------------------------ *
   * Stage: pinch separation
   * ------------------------------------------------------------------ */

  /* Two sheets meeting at a single vertex are pulled apart by giving each fan
   * its own copy of the vertex and nudging that copy toward its own fan's rim,
   * i.e. back into the shell the fan belongs to. Each shell stays closed and
   * the shared point becomes two points with a gap between them.
   *
   * This is the risky stage, and the risk is entirely about the angle the two
   * sheets make at the shared vertex:
   *
   *   Wide, convex pinch (two cones tip to tip): each apex moves into its own
   *   cone, directly away from the other. Always safe.
   *
   *   Tight pinch (one sheet lying inside the cone the other sheet opens into
   *   — a spike standing in a pit, a fold closing on itself): "into my own
   *   shell" points straight at the other sheet, because the other sheet is
   *   what is occupying that space. The fan walls sweep across it and the
   *   result self-intersects.
   *
   * Nothing local to the vertex distinguishes the two: the fans look the same,
   * and how tight is too tight depends on the clearance as well as the angle.
   * Measuring self-intersections after the fact does distinguish them, which is
   * why this stage is applied to a trial copy and kept only if the gate passes.
   * See docs/NSO_Repair.md "Why the pinch stage is gated". */
  function separatePinches(m, nudgeFrac) {
    var pinches = pinchVertices(m);
    if (!pinches.length) return { split: 0, moved: 0 };
    var split = 0, moved = 0;
    for (var i = 0; i < pinches.length; i++) {
      var p = pinches[i];
      var groups = p.groups;

      // Rims are measured before anything moves, so every fan sees the same
      // original vertex position.
      var rims = [];
      for (var g = 0; g < groups.length; g++) rims.push(fanRim(m, p.v, groups[g]));

      /* Every copy is made from the ORIGINAL position, captured here. Reading
       * m.pos[p.v] inside the loop would hand the second fan the first fan's
       * nudge on top of its own. */
      var origin = vtx(m, p.v);

      for (g = 0; g < groups.length; g++) {
        var target;
        if (g === 0) {
          target = p.v; // first fan keeps the original index
        } else {
          target = m.pos.length / 3;
          m.pos.push(origin[0], origin[1], origin[2]);
          for (var f = 0; f < groups[g].length; f++) {
            var fi = groups[g][f];
            for (var s = 0; s < 3; s++) if (m.faces[fi * 3 + s] === p.v) m.faces[fi * 3 + s] = target;
          }
          split++;
        }
        var rim = rims[g];
        if (!rim) continue;
        var dir = [rim.c[0] - rim.p[0], rim.c[1] - rim.p[1], rim.c[2] - rim.p[2]];
        var d = len(dir);
        if (!(d > 0)) continue;
        var step = rim.meanEdge * nudgeFrac;
        m.pos[target * 3] += dir[0] / d * step;
        m.pos[target * 3 + 1] += dir[1] / d * step;
        m.pos[target * 3 + 2] += dir[2] / d * step;
        moved++;
      }
    }
    return { split: split, moved: moved };
  }

  /* Centroid of the fan's rim (every vertex of the fan that is not v) and the
   * mean length of the spokes reaching it. */
  function fanRim(m, v, faces) {
    var P = vtx(m, v);
    var sx = 0, sy = 0, sz = 0, n = 0, lenSum = 0;
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      for (var s = 0; s < 3; s++) {
        var o = m.faces[f * 3 + s];
        if (o === v) continue;
        var O = vtx(m, o);
        sx += O[0]; sy += O[1]; sz += O[2];
        lenSum += len(sub(O, P));
        n++;
      }
    }
    if (!n) return null;
    return { p: P, c: [sx / n, sy / n, sz / n], meanEdge: lenSum / n };
  }

  /* ------------------------------------------------------------------ *
   * commit
   * ------------------------------------------------------------------ */

  function commit(rawTris, options) {
    var opts = options || {};
    var report = {
      version: VERSION,
      weldTol: (opts.weldTol != null ? opts.weldTol : WELD_TOL),
      splitEps: (opts.splitEps != null ? opts.splitEps : SPLIT_EPS),
      applied: false,
      declined: false,
      reason: null,
      stages: [],
      counts: {
        welded: 0,
        weldedNear: 0,
        degenerateRemoved: 0,
        exactDuplicatesRemoved: 0,
        reversedDuplicatesRemoved: 0,
        flapTrisRemoved: 0,
        orphanTrisRemoved: 0,
        tJunctionSplits: 0,
        holesFilled: 0,
        holeTrisAdded: 0,
        pinchVertsSplit: 0
      },
      gate: { blockedStages: [], selfIntBefore: 0, selfIntAfter: 0, oddBefore: 0, oddAfter: 0 },
      before: null,
      after: null,
      rejected: null,
      triDelta: 0,
      volumeDelta: 0,
      volumeDeltaRel: 0
    };

    try {
      if (!rawTris || typeof rawTris.length !== 'number') {
        report.reason = 'no geometry';
        report.declined = true;
        return { rawTris: rawTris, report: report, ok: false };
      }
      if (rawTris.length < 9 || rawTris.length % 9 !== 0) {
        report.reason = 'raw soup is not a whole number of triangles (' + rawTris.length + ' floats)';
        report.declined = true;
        return { rawTris: rawTris, report: report, ok: false };
      }

      /* A non-finite coordinate is not a topology defect, it is a broken input,
       * and every measurement below would quietly produce NaN. Decline instead
       * of handing the caller back a mesh that looks repaired. */
      for (var q = 0; q < rawTris.length; q++) {
        if (!isFinite(rawTris[q])) {
          report.reason = 'non-finite coordinate at float ' + q + ' (triangle ' +
                          Math.floor(q / 9) + ')';
          report.declined = true;
          return { rawTris: rawTris, report: report, ok: false };
        }
      }

      var weldTol = report.weldTol;
      var splitEps = report.splitEps;

      var w = weldToIndexed(rawTris, weldTol);
      var mesh = w.mesh;
      report.counts.welded = w.collapsed;
      report.counts.weldedNear = w.collapsedNear;
      report.before = analyze(mesh);
      report.gate.selfIntBefore = report.before.selfIntersections;
      report.gate.oddBefore = report.before.oddEdges;

      /* The input soup is unwelded by definition, so `before` is measured on the
       * welded mesh: it is the same surface, and every later count is relative
       * to it. The soup's own triangle count is kept for the no-op check. */
      var inputTriCount = rawTris.length / 9;
      /* Vertex count as the mesh arrived, before any stage could add to it.
       * hole-fill uses it to tell a hole in the model from a seam we opened
       * ourselves. */
      var inputVertexCount = mesh.pos.length / 3;

      var stageLog = report.stages;

      function note(name, applied, extra) {
        var rec = { name: name, applied: !!applied };
        if (extra) for (var k in extra) rec[k] = extra[k];
        stageLog.push(rec);
        return rec;
      }

      // --- unconditional, always-safe stages -------------------------------
      var degen = stripDegenerate(mesh);
      report.counts.degenerateRemoved = degen;
      note('degenerate', degen > 0, { removed: degen });

      var dup = stripDuplicateFaces(mesh);
      report.counts.exactDuplicatesRemoved = dup.exact;
      report.counts.reversedDuplicatesRemoved = dup.reversed;
      note('duplicate-faces', (dup.exact + dup.reversed) > 0, { exact: dup.exact, reversed: dup.reversed });

      if (opts.peelFlaps !== false) {
        var peel = peelFlaps(mesh);
        report.counts.flapTrisRemoved = peel.removed;
        note('flap-peel', peel.removed > 0, { removed: peel.removed, budgetHit: peel.budgetHit });
        if (peel.budgetHit) report.gate.blockedStages.push('flap-peel:budget');

        var orphans = dropOrphanComponents(mesh);
        report.counts.orphanTrisRemoved = orphans;
        note('orphan-components', orphans > 0, { removed: orphans });
      }

      // --- gated stages ----------------------------------------------------
      var selfRef = report.gate.selfIntBefore;
      var maxIncrease = (opts.maxSelfIntersectionIncrease != null) ? opts.maxSelfIntersectionIncrease : 0;
      var gateOn = opts.gate !== false;

      /* Runs a risky stage on a THROWAWAY copy and keeps it only if the result
       * does not self-intersect more than the input did. A blocked stage leaves
       * `mesh` and every counter exactly as it found them — the counts ride on
       * the stage result and are only committed once the gate has passed, so a
       * blocked repair can never show up as an applied one. */
      function tryStage(name, fn) {
        var trial = cloneMesh(mesh);
        var res = fn(trial);
        if (!res || res.changed === false) { note(name, false, res && res.info); return null; }
        if (gateOn) {
          var selfAfter = countSelfIntersections(trial);
          if (selfAfter > selfRef + maxIncrease) {
            var info = res.info || {};
            info.selfIntWouldBe = selfAfter;
            info.selfIntBefore = selfRef;
            note(name, false, info);
            report.gate.blockedStages.push(name + ':selfInt ' + selfRef + '->' + selfAfter);
            return null;
          }
        }
        mesh = trial;
        if (res.counts) for (var k in res.counts) report.counts[k] = res.counts[k];
        note(name, true, res.info);
        return res;
      }

      if (opts.splitTJunctions !== false) {
        tryStage('t-junction', function (trial) {
          var before = faceCount(trial);
          var r = splitTJunctions(trial, splitEps);
          if (r.overflow) { return { changed: false, info: { overflow: true } }; }
          if (!r.splits) return { changed: false, info: { splits: 0 } };
          return {
            changed: true,
            counts: { tJunctionSplits: r.splits },
            info: { splits: r.splits, triDelta: faceCount(trial) - before }
          };
        });
      }

      if (opts.separatePinches !== false) {
        tryStage('pinch-separate', function (trial) {
          var r = separatePinches(trial, (opts.nudgeFrac != null ? opts.nudgeFrac : NUDGE_FRAC));
          if (!r.split) return { changed: false, info: { split: 0 } };
          return {
            changed: true,
            counts: { pinchVertsSplit: r.split },
            info: { split: r.split, moved: r.moved }
          };
        });
      }

      if (opts.fillHoles !== false) {
        tryStage('hole-fill', function (trial) {
          var r = fillHoles(trial, inputVertexCount);
          if (!r.filled) {
            return { changed: false, info: { filled: 0, skipped: r.skipped, selfMade: r.selfMade } };
          }
          return {
            changed: true,
            counts: { holesFilled: r.filled, holeTrisAdded: r.added },
            info: { filled: r.filled, added: r.added, skipped: r.skipped, selfMade: r.selfMade }
          };
        });
      }

      // --- final gate ------------------------------------------------------
      var finalMetrics = analyze(mesh);
      report.gate.selfIntAfter = finalMetrics.selfIntersections;
      report.gate.oddAfter = finalMetrics.oddEdges;

      /* `after` always describes the mesh the caller actually receives. When the
       * gate rejects the repair the caller receives the INPUT, so `after` is
       * `before` and both deltas are zero; the measurements of the mesh that was
       * thrown away go to `rejected`, where they are useful for working out why
       * without ever being mistaken for the result. */
      function settle(applied) {
        if (applied) {
          report.after = finalMetrics;
          report.triDelta = finalMetrics.tris - inputTriCount;
          report.volumeDelta = finalMetrics.volume - report.before.volume;
        } else {
          report.after = report.before;
          report.rejected = finalMetrics;
          report.triDelta = 0;
          report.volumeDelta = 0;
        }
        report.volumeDeltaRel = report.before.volume !== 0
          ? report.volumeDelta / Math.abs(report.before.volume) : 0;
      }

      if (finalMetrics.tris === 0) {
        report.declined = true;
        report.reason = 'repair emptied the mesh';
        settle(false);
        return { rawTris: rawTris, report: report, ok: true };
      }

      if (gateOn) {
        if (finalMetrics.selfIntersections > report.gate.selfIntBefore + maxIncrease) {
          report.declined = true;
          report.reason = 'final gate: self-intersections ' + report.gate.selfIntBefore +
                          ' -> ' + finalMetrics.selfIntersections;
          report.gate.blockedStages.push('final:selfInt');
          settle(false);
          return { rawTris: rawTris, report: report, ok: true };
        }
        if (finalMetrics.oddEdges > report.before.oddEdges) {
          report.declined = true;
          report.reason = 'final gate: odd edges ' + report.before.oddEdges +
                          ' -> ' + finalMetrics.oddEdges;
          report.gate.blockedStages.push('final:oddEdges');
          settle(false);
          return { rawTris: rawTris, report: report, ok: true };
        }
      }

      /* Nothing to do is a legitimate, successful outcome — and the caller's
       * array comes straight back, unchanged and unreallocated. */
      var changedSomething =
        report.counts.weldedNear > 0 ||
        report.counts.degenerateRemoved > 0 ||
        report.counts.exactDuplicatesRemoved > 0 ||
        report.counts.reversedDuplicatesRemoved > 0 ||
        report.counts.flapTrisRemoved > 0 ||
        report.counts.orphanTrisRemoved > 0 ||
        report.counts.tJunctionSplits > 0 ||
        report.counts.holesFilled > 0 ||
        report.counts.pinchVertsSplit > 0;

      if (!changedSomething) {
        report.applied = false;
        report.reason = report.gate.blockedStages.length
          ? 'nothing applied (gate blocked: ' + report.gate.blockedStages.join(', ') + ')'
          : 'nothing to repair';
        report.declined = report.gate.blockedStages.length > 0;
        settle(false);
        return { rawTris: rawTris, report: report, ok: true };
      }

      settle(true);
      report.applied = true;
      report.reason = report.gate.blockedStages.length
        ? 'applied, with gate blocks: ' + report.gate.blockedStages.join(', ')
        : 'applied';
      return { rawTris: toRaw(mesh), report: report, ok: true };

    } catch (err) {
      report.applied = false;
      report.declined = true;
      report.reason = 'internal error: ' + ((err && err.message) || err);
      report.error = String((err && err.stack) || err);
      return { rawTris: rawTris, report: report, ok: false };
    }
  }

  /* Metrics for a raw soup, without repairing it. Used by the regression
   * runner and useful for any caller that wants a before/after of its own. */
  function inspect(rawTris, options) {
    var opts = options || {};
    var tol = (opts.weldTol != null ? opts.weldTol : WELD_TOL);
    var w = weldToIndexed(rawTris, tol);
    var out = analyze(w.mesh, opts);
    out.soupTris = rawTris.length / 9;
    out.weldedVerts = w.collapsed;
    out.weldedNear = w.collapsedNear;
    return out;
  }

  global.NSO_Repair = {
    VERSION: VERSION,
    WELD_TOL: WELD_TOL,
    SPLIT_EPS: SPLIT_EPS,
    NUDGE_FRAC: NUDGE_FRAC,
    commit: commit,
    inspect: inspect,
    /* Exposed for tools/nso_selfint_equiv_test.js, which holds this
     * implementation to tools/mesh_validate.py pair-for-pair. */
    _selfIntersectionDetail: countSelfIntersectionsDetail,
    _weldToIndexed: weldToIndexed,
    _triTriIntersect: triTriIntersect
  };

})(typeof window !== 'undefined' ? window : this);
