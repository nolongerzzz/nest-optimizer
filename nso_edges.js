/* ============================================================
   nso_edges.js - THREE.EdgesGeometry's edges, for a non-indexed position
   array, without THREE and without a string per vertex.

   Loads as a classic script (window.NSO_Edges, and self.NSO_Edges in a worker)
   and as a Node module (require('./nso_edges.js')). Pure: positions in, a
   Float32Array of segment endpoints (x y z, x y z, ...) out.

   WHY. The white outline of the selected piece is an EdgesGeometry(geometry, 15).
   three builds it with a template string for every vertex and every edge of
   every triangle: 2.8 million strings at 947,000 triangles, 5.4 s of the page's
   thread - paid on every selection, every To plate, every cutter opening, every
   pose change (refreshOutline runs on all of them), and a window that cannot be
   clicked while it runs.

   THE SAME EDGES. This is EdgesGeometry's loop, line for line, with the two
   dictionaries made of numbers: a corner is welded to any corner that rounds to
   the same 1e-4 (three's `precisionPoints`), an edge is a pair of welded
   corners, a triangle with two corners welded is skipped, an edge meeting its
   reverse is kept when the two faces' normals are at least `angle` apart and
   dropped otherwise, and what is left unmatched is a boundary edge, emitted in
   the order edges were first seen. The result is the very array three makes
   (tools/nso_edges_test.js holds it to that, bit for bit, on random meshes and a
   sphere) - the page uses three's own for a small piece and this, in a worker,
   for a big one.
   ============================================================ */
(function (root) {
  'use strict';

  var PRECISION = 1e4;                 // three: Math.pow(10, 4)

  function edgesOf(pos, thresholdAngle) {
    var angle = thresholdAngle == null ? 1 : thresholdAngle;
    var thresholdDot = Math.cos((Math.PI / 180) * angle);     // MathUtils.DEG2RAD * angle
    var nTri = (pos.length / 9) | 0;

    /* welded corner ids: open addressing over the rounded coordinates */
    var cap = 1; while (cap < nTri * 3 * 2) cap <<= 1;
    var mask = cap - 1;
    var table = new Int32Array(cap).fill(-1);
    var rx = new Float64Array(nTri * 3), ry = new Float64Array(nTri * 3), rz = new Float64Array(nTri * 3);
    var nv = 0;
    function weld(x, y, z) {
      var qx = Math.round(x * PRECISION), qy = Math.round(y * PRECISION), qz = Math.round(z * PRECISION);
      var h = (Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) & mask;
      for (;;) {
        var id = table[h];
        if (id < 0) { table[h] = nv; rx[nv] = qx; ry[nv] = qy; rz[nv] = qz; return nv++; }
        if (rx[id] === qx && ry[id] === qy && rz[id] === qz) return id;
        h = (h + 1) & mask;
      }
    }

    /* edges, in the order first seen: end corners (as triangle-corner numbers, so the
       unmatched ones can read their coordinates back), the face normal, alive */
    var edgeAt = new Map();                       // welded (a, b) -> record
    var recA = [], recB = [], recNx = [], recNy = [], recNz = [], alive = [];
    var STRIDE = 67108864;                        // 2^26 welded corners is more than any piece has

    var out = [];
    var ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, L;
    var hs = [0, 0, 0];
    for (var t = 0; t < nTri; t++) {
      var o = t * 9;
      ax = pos[o]; ay = pos[o + 1]; az = pos[o + 2];
      bx = pos[o + 3]; by = pos[o + 4]; bz = pos[o + 5];
      cx = pos[o + 6]; cy = pos[o + 7]; cz = pos[o + 8];
      /* Triangle.getNormal: (c - b) x (a - b), normalised, zero when it has no area */
      var ux = cx - bx, uy = cy - by, uz = cz - bz;
      var vx = ax - bx, vy = ay - by, vz = az - bz;
      nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
      L = nx * nx + ny * ny + nz * nz;
      if (L > 0) { var k = 1 / Math.sqrt(L); nx *= k; ny *= k; nz *= k; } else { nx = 0; ny = 0; nz = 0; }
      hs[0] = weld(ax, ay, az); hs[1] = weld(bx, by, bz); hs[2] = weld(cx, cy, cz);
      if (hs[0] === hs[1] || hs[1] === hs[2] || hs[2] === hs[0]) continue;
      for (var j = 0; j < 3; j++) {
        var jn = (j + 1) % 3, h0 = hs[j], h1 = hs[jn];
        var rev = edgeAt.get(h1 * STRIDE + h0);
        if (rev !== undefined && alive[rev]) {
          if (nx * recNx[rev] + ny * recNy[rev] + nz * recNz[rev] <= thresholdDot) {
            out.push(pos[o + j * 3], pos[o + j * 3 + 1], pos[o + j * 3 + 2],
                     pos[o + jn * 3], pos[o + jn * 3 + 1], pos[o + jn * 3 + 2]);
          }
          alive[rev] = 0;
        } else {
          var key = h0 * STRIDE + h1;
          if (!edgeAt.has(key)) {
            edgeAt.set(key, recA.length);
            recA.push(o + j * 3); recB.push(o + jn * 3);
            recNx.push(nx); recNy.push(ny); recNz.push(nz);
            alive.push(1);
          }
        }
      }
    }
    for (var r = 0; r < recA.length; r++) {
      if (!alive[r]) continue;
      var a = recA[r], b = recB[r];
      out.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2]);
    }
    return new Float32Array(out);
  }

  /* The worker's entry: the segments, moved rather than copied. */
  function edgesOfTransfer(pos, angle) {
    var e = edgesOf(pos, angle);
    return (typeof self !== 'undefined' && self.NSO_Work && self.NSO_Work.transfer) ? self.NSO_Work.transfer(e, [e.buffer]) : e;
  }

  var api = { edgesOf: edgesOf, edgesOfTransfer: edgesOfTransfer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Edges = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
