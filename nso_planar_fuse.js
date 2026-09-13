/* ============================================================
   NSO planar fuse — congruent-face chain fusion
   no ES modules, browser-global like the rest of the app

   Two watertight pieces that came from the same cut share a face
   that is congruent by construction: same vertex positions, same
   triangulation. Each piece closed that face with its own cap
   triangles to stay watertight on its own. Fusing the pair means
   dropping BOTH caps and welding the two now-open boundary loops
   into one continuous surface. Triangle count falls by
   (capA + capB); enclosed volume does not change.

   The whole correctness question is congruence detection. A face
   pair that is "almost" congruent must be REFUSED, not half-fused:
   a partial seam still looks like a solid until the edges are
   counted. See NSO_fuseTolerance for the tolerance policy and why
   it is relative, not the absolute epsilon used elsewhere here.
   ============================================================ */

/* Soup convention, same as the rest of NSO: a flat array of floats,
   9 per triangle (3 verts x xyz), no index buffer. */

/* Tolerance constants. These are NOT hand-picked - see tools/nso_fuse_drift_probe.js
   and the ULP probe results quoted below.

   The live pipeline stores every world coordinate in a Float32Array
   (meshToWorldSoup, app-join.js:157), so float32 spacing, not any fixed
   distance, is what actually limits congruence detection. Measured worst-case
   disagreement between two copies of the same shared face, each reached
   through its own piece's centre-and-place path, over 600k randomised trials
   spanning +-2000mm of plate reach: exactly 2.0 float32 ULP of the coordinate
   scale (1.8e-7 relative), flat across the whole range.

   So the budget is expressed in float32 ULP, which is the unit the error is
   actually quantised in. 32 ULP is a 16x margin over the measured worst case
   and still leaves a 100x+ reject margin against a real 0.01mm mis-registration
   anywhere on a normal plate. */
var NSO_FUSE_ULP = 32;                              /* float32 ULP of budget */
var NSO_FUSE_REL_EPS = NSO_FUSE_ULP * Math.pow(2, -24);  /* ~1.907e-6 */
var NSO_FUSE_ABS_FLOOR = 1e-6; /* mm, only bites for geometry sitting on the origin */
/* Hard ceiling on the accept window. Without it the relative term grows without
   bound and a part parked far from the origin would start fusing faces that are
   genuinely millimetres apart. 2 microns is 500x below MIN_CUT_SIDE_MM, and it
   only engages past ~1000mm of reach - beyond that, revisit this. */
var NSO_FUSE_ABS_CEIL = 2e-3;
var NSO_FUSE_PLANAR_REL = 4;   /* cap flatness allowance, in units of tol */

function NSO_fuseTriCount(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }

/* ---- tolerance ----------------------------------------------------------
   Every tolerance already in this repo is a hardcoded absolute number
   (NSO_EPS 1e-7, weldTol 1e-4, raw2DWeldLoop 0.08, the checker's own 1e-5
   quantize). That is wrong for congruence detection, because the error we
   are trying to tolerate is NOT a fixed distance - it is float32 rounding,
   and float32 spacing is proportional to coordinate magnitude. The live
   pipeline stores world coordinates in a Float32Array (meshToWorldSoup,
   app-join.js), so a vertex at x=10 carries ~1e-6 mm of representation
   noise while the same vertex translated to x=500 carries ~3e-5 mm. One
   absolute epsilon cannot be right at both ends of the plate: tight enough
   to reject a real 0.01mm mismatch near the origin is too tight to accept
   an identical face parked far from it.

   So: tol scales with coordinate magnitude, with an absolute floor.
   scale is max(|coord|) rather than bbox extent, because it is distance
   from the origin - not part size - that sets float32 spacing. */
function NSO_fuseTolerance(soups, opts) {
  opts = opts || {};
  var relEps = (opts.relEps != null) ? opts.relEps : NSO_FUSE_REL_EPS;
  var absFloor = (opts.absFloor != null) ? opts.absFloor : NSO_FUSE_ABS_FLOOR;
  var absCeil = (opts.absCeil != null) ? opts.absCeil : NSO_FUSE_ABS_CEIL;
  var maxAbs = 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var s = 0; s < soups.length; s++) {
    var soup = soups[s];
    for (var i = 0; i < soup.length; i++) {
      var v = soup[i], a = v < 0 ? -v : v;
      if (a > maxAbs) maxAbs = a;
      var k = i % 3;
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  var dx = hi[0] - lo[0], dy = hi[1] - lo[1], dz = hi[2] - lo[2];
  var diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  var scale = Math.max(maxAbs, diag);
  var tol = Math.min(absCeil, Math.max(absFloor, relEps * scale));
  return {
    tol: tol, scale: scale, maxAbs: maxAbs, diag: diag,
    relEps: relEps, absFloor: absFloor, absCeil: absCeil,
    ulpBudget: relEps / Math.pow(2, -24),
    capped: (relEps * scale) > absCeil
  };
}

/* ---- tolerant vertex grid ----------------------------------------------
   Cell size is tol and every lookup probes the 3x3x3 neighbourhood. The
   Math.round(x/tol) keys used elsewhere in this repo skip that probe, so
   two points a nanometre apart that straddle a cell boundary get different
   keys and never match. For a congruence test that failure mode is exactly
   the one that matters, so it is paid for here. */
function NSO_fuseVertGrid(tol) {
  var cells = new Map(), pts = [], t2 = tol * tol;
  function ckey(a, b, c) { return a + '_' + b + '_' + c; }
  return {
    pts: pts,
    /* add-or-find: returns the id of an existing point within tol, else adds */
    intern: function (x, y, z) {
      var id = this.find(x, y, z);
      if (id >= 0) return id;
      id = pts.length / 3;
      pts.push(x, y, z);
      var k = ckey(Math.floor(x / tol), Math.floor(y / tol), Math.floor(z / tol));
      var bucket = cells.get(k);
      if (!bucket) { bucket = []; cells.set(k, bucket); }
      bucket.push(id);
      return id;
    },
    /* nearest existing point within tol, or -1 */
    find: function (x, y, z) {
      var bx = Math.floor(x / tol), by = Math.floor(y / tol), bz = Math.floor(z / tol);
      var best = -1, bestD = t2;
      for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) for (var k = -1; k <= 1; k++) {
        var bucket = cells.get(ckey(bx + i, by + j, bz + k));
        if (!bucket) continue;
        for (var b = 0; b < bucket.length; b++) {
          var id = bucket[b], o = id * 3;
          var ddx = pts[o] - x, ddy = pts[o + 1] - y, ddz = pts[o + 2] - z;
          var d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d <= bestD) { bestD = d; best = id; }
        }
      }
      return best;
    }
  };
}

function NSO_fuseTriKey(a, b, c) {
  var x = a, y = b, z = c, t;
  if (x > y) { t = x; x = y; y = t; }
  if (y > z) { t = y; y = z; z = t; }
  if (x > y) { t = x; x = y; y = t; }
  return x + '|' + y + '|' + z;
}

function NSO_fuseNewell(soup, tris) {
  var nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, n = 0;
  for (var t = 0; t < tris.length; t++) {
    var o = tris[t] * 9;
    for (var e = 0; e < 3; e++) {
      var i = o + e * 3, j = o + ((e + 1) % 3) * 3;
      nx += (soup[i + 1] - soup[j + 1]) * (soup[i + 2] + soup[j + 2]);
      ny += (soup[i + 2] - soup[j + 2]) * (soup[i] + soup[j]);
      nz += (soup[i] - soup[j]) * (soup[i + 1] + soup[j + 1]);
      cx += soup[i]; cy += soup[i + 1]; cz += soup[i + 2]; n++;
    }
  }
  var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (L === 0 || !n) return null;
  return { nx: nx / L, ny: ny / L, nz: nz / L, cx: cx / n, cy: cy / n, cz: cz / n };
}

function NSO_fusePlaneDist(p, x, y, z) {
  return (x - p.cx) * p.nx + (y - p.cy) * p.ny + (z - p.cz) * p.nz;
}

/* triangles of `soup` that lie on plane `p` within planarTol AND are
   edge-connected to `seed`. Connectivity keeps a coplanar-but-separate
   patch elsewhere on the piece from being swept into the cap. */
function NSO_fuseGrowCap(soup, vid, p, planarTol, seed) {
  var n = NSO_fuseTriCount(soup);
  var onPlane = [], isOn = new Uint8Array(n);
  for (var t = 0; t < n; t++) {
    var o = t * 9, ok = 1;
    for (var k = 0; k < 3; k++) {
      var d = NSO_fusePlaneDist(p, soup[o + k * 3], soup[o + k * 3 + 1], soup[o + k * 3 + 2]);
      if (Math.abs(d) > planarTol) { ok = 0; break; }
    }
    if (ok) { isOn[t] = 1; onPlane.push(t); }
  }
  /* edge -> triangles, restricted to the on-plane set */
  var edgeMap = new Map();
  for (var i = 0; i < onPlane.length; i++) {
    var tt = onPlane[i], v = [vid[tt * 3], vid[tt * 3 + 1], vid[tt * 3 + 2]];
    for (var e = 0; e < 3; e++) {
      var a = v[e], b = v[(e + 1) % 3];
      var ek = a < b ? (a + '|' + b) : (b + '|' + a);
      var L = edgeMap.get(ek);
      if (!L) { L = []; edgeMap.set(ek, L); }
      L.push(tt);
    }
  }
  var seen = new Uint8Array(n), stack = [], out = [];
  for (var s = 0; s < seed.length; s++) if (isOn[seed[s]] && !seen[seed[s]]) { seen[seed[s]] = 1; stack.push(seed[s]); }
  while (stack.length) {
    var cur = stack.pop();
    out.push(cur);
    var cv = [vid[cur * 3], vid[cur * 3 + 1], vid[cur * 3 + 2]];
    for (var e2 = 0; e2 < 3; e2++) {
      var a2 = cv[e2], b2 = cv[(e2 + 1) % 3];
      var ek2 = a2 < b2 ? (a2 + '|' + b2) : (b2 + '|' + a2);
      var nb = edgeMap.get(ek2) || [];
      for (var q = 0; q < nb.length; q++) if (!seen[nb[q]]) { seen[nb[q]] = 1; stack.push(nb[q]); }
    }
  }
  out.sort(function (x, y) { return x - y; });
  return out;
}

/* ---- congruence detection ---------------------------------------------
   Returns the shared cap on each side, or a refusal with a reason. The
   check is holistic on purpose: EVERY triangle of the cap on both sides
   must have a partner, and every vertex of every such triangle must match.
   One unpaired cap triangle refuses the whole fuse rather than welding the
   part that happened to line up. */
function NSO_findSharedFace(soupA, soupB, opts) {
  opts = opts || {};
  var tolInfo = opts.tolInfo || NSO_fuseTolerance([soupA, soupB], opts);
  var tol = tolInfo.tol;
  var nA = NSO_fuseTriCount(soupA), nB = NSO_fuseTriCount(soupB);
  if (!nA || !nB) return { ok: false, reason: 'empty soup', tolInfo: tolInfo };

  /* One shared vertex space. A is interned first, so where the two pieces
     disagree in the last float32 places A's coordinates become canonical and
     the weld snaps B onto A. That direction matters for a chain: every joint
     resolves toward the head piece, so error cannot accumulate down the chain. */
  var grid = NSO_fuseVertGrid(tol);
  var vidA = new Int32Array(nA * 3), vidB = new Int32Array(nB * 3);
  var i, k, o;
  for (i = 0; i < nA * 3; i++) { o = i * 3; vidA[i] = grid.intern(soupA[o], soupA[o + 1], soupA[o + 2]); }
  /* B vertices only match into A's space; unmatched B verts get their own ids */
  for (i = 0; i < nB * 3; i++) { o = i * 3; vidB[i] = grid.intern(soupB[o], soupB[o + 1], soupB[o + 2]); }

  var bByKey = new Map();
  for (var t = 0; t < nB; t++) {
    var kb = NSO_fuseTriKey(vidB[t * 3], vidB[t * 3 + 1], vidB[t * 3 + 2]);
    var L = bByKey.get(kb);
    if (!L) { L = []; bByKey.set(kb, L); }
    L.push(t);
  }

  var seedA = [], seedB = [], pairs = [], usedB = new Uint8Array(nB);
  for (t = 0; t < nA; t++) {
    var ka = NSO_fuseTriKey(vidA[t * 3], vidA[t * 3 + 1], vidA[t * 3 + 2]);
    var cand = bByKey.get(ka);
    if (!cand) continue;
    var picked = -1;
    for (var c = 0; c < cand.length; c++) if (!usedB[cand[c]]) { picked = cand[c]; break; }
    if (picked < 0) continue;
    usedB[picked] = 1;
    seedA.push(t); seedB.push(picked); pairs.push([t, picked]);
  }
  if (!seedA.length) return { ok: false, reason: 'no congruent triangle found between the pieces', tolInfo: tolInfo, matched: 0 };

  var planeA = NSO_fuseNewell(soupA, seedA);
  if (!planeA) return { ok: false, reason: 'matched region is degenerate (zero area)', tolInfo: tolInfo };

  var planarTol = tol * NSO_FUSE_PLANAR_REL;
  for (i = 0; i < seedA.length; i++) {
    o = seedA[i] * 9;
    for (k = 0; k < 3; k++) {
      if (Math.abs(NSO_fusePlaneDist(planeA, soupA[o + k * 3], soupA[o + k * 3 + 1], soupA[o + k * 3 + 2])) > planarTol) {
        return { ok: false, reason: 'matched triangles are not coplanar - not a single shared face', tolInfo: tolInfo };
      }
    }
  }

  var capA = NSO_fuseGrowCap(soupA, vidA, planeA, planarTol, seedA);
  var capB = NSO_fuseGrowCap(soupB, vidB, planeA, planarTol, seedB);

  /* holistic gate: the cap each piece put on this plane must be matched in
     full, on both sides. Any surplus means the faces are not the same face. */
  if (capA.length !== seedA.length || capB.length !== seedB.length || capA.length !== capB.length) {
    return {
      ok: false,
      reason: 'partial congruence: cap A ' + capA.length + ' tris, cap B ' + capB.length +
              ' tris, only ' + seedA.length + ' matched - refusing to half-fuse',
      tolInfo: tolInfo, capA: capA, capB: capB, matched: seedA.length
    };
  }

  /* the two caps must face each other, not the same way */
  var planeB = NSO_fuseNewell(soupB, capB);
  var dot = planeA.nx * planeB.nx + planeA.ny * planeB.ny + planeA.nz * planeB.nz;
  if (dot > -0.9) {
    return { ok: false, reason: 'shared face normals are not opposed (dot ' + dot.toFixed(4) + ') - pieces overlap rather than abut', tolInfo: tolInfo };
  }

  /* safety rail the rest of this repo does not have: refuse if the
     tolerance is a meaningful fraction of the geometry it is judging */
  var minEdge = Infinity;
  for (i = 0; i < capA.length; i++) {
    o = capA[i] * 9;
    for (k = 0; k < 3; k++) {
      var p = o + k * 3, qq = o + ((k + 1) % 3) * 3;
      var ex = soupA[p] - soupA[qq], ey = soupA[p + 1] - soupA[qq + 1], ez = soupA[p + 2] - soupA[qq + 2];
      var len = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (len > 0 && len < minEdge) minEdge = len;
    }
  }
  if (minEdge < tol * 100) {
    return { ok: false, reason: 'tolerance ' + tol.toExponential(3) + ' is too coarse for this face (shortest cap edge ' + minEdge.toExponential(3) + ')', tolInfo: tolInfo };
  }

  return {
    ok: true, capA: capA, capB: capB, pairs: pairs, plane: planeA,
    tolInfo: tolInfo, matched: seedA.length, minCapEdge: minEdge,
    vidA: vidA, vidB: vidB, grid: grid
  };
}

/* ---- fuse one pair ------------------------------------------------------ */
function NSO_planarFusePair(soupA, soupB, opts) {
  opts = opts || {};
  var found = opts.found || NSO_findSharedFace(soupA, soupB, opts);
  if (!found.ok) return { ok: false, reason: found.reason, tolInfo: found.tolInfo, found: found };

  var tol = found.tolInfo.tol;
  var nA = NSO_fuseTriCount(soupA), nB = NSO_fuseTriCount(soupB);
  var dropA = new Uint8Array(nA), dropB = new Uint8Array(nB), i, k, o;
  for (i = 0; i < found.capA.length; i++) dropA[found.capA[i]] = 1;
  for (i = 0; i < found.capB.length; i++) dropB[found.capB[i]] = 1;

  /* Weld: the seam vertices are shared by construction but may differ in
     the last float32 places after a transform. Snap every surviving vertex
     that sits on a seam position to one canonical value, so the two open
     boundary loops become literally the same loop and the result is
     watertight by bit equality, not merely by rounding. A's values win. */
  var seam = NSO_fuseVertGrid(tol), canon = [];
  function seamAdd(x, y, z) {
    var id = seam.find(x, y, z);
    if (id >= 0) return;
    id = seam.intern(x, y, z);
    canon[id] = [x, y, z];
  }
  for (i = 0; i < found.capA.length; i++) {
    o = found.capA[i] * 9;
    for (k = 0; k < 3; k++) seamAdd(soupA[o + k * 3], soupA[o + k * 3 + 1], soupA[o + k * 3 + 2]);
  }

  var keptA = nA - found.capA.length, keptB = nB - found.capB.length;
  var out = new Float32Array((keptA + keptB) * 9);
  var w = 0, snapped = 0, maxSnap = 0;
  function emit(soup, t) {
    var oo = t * 9;
    for (var kk = 0; kk < 3; kk++) {
      var x = soup[oo + kk * 3], y = soup[oo + kk * 3 + 1], z = soup[oo + kk * 3 + 2];
      var id = seam.find(x, y, z);
      if (id >= 0) {
        var c = canon[id];
        if (c[0] !== x || c[1] !== y || c[2] !== z) {
          var d = Math.sqrt((c[0] - x) * (c[0] - x) + (c[1] - y) * (c[1] - y) + (c[2] - z) * (c[2] - z));
          if (d > maxSnap) maxSnap = d;
          snapped++;
        }
        x = c[0]; y = c[1]; z = c[2];
      }
      out[w++] = x; out[w++] = y; out[w++] = z;
    }
  }
  for (var t = 0; t < nA; t++) if (!dropA[t]) emit(soupA, t);
  for (t = 0; t < nB; t++) if (!dropB[t]) emit(soupB, t);

  return {
    ok: true, soup: out,
    stats: {
      triIn: nA + nB, triOut: keptA + keptB,
      capA: found.capA.length, capB: found.capB.length,
      removed: found.capA.length + found.capB.length,
      matched: found.matched, tol: tol, scale: found.tolInfo.scale,
      vertsSnapped: snapped, maxSnapDist: maxSnap, minCapEdge: found.minCapEdge
    }
  };
}

/* ---- fuse a chain ------------------------------------------------------- */
function NSO_planarFuseChain(soups, opts) {
  opts = opts || {};
  if (!soups || soups.length === 0) return { ok: false, reason: 'no pieces' };
  if (soups.length === 1) return { ok: true, soup: soups[0], joints: [], stats: { triIn: NSO_fuseTriCount(soups[0]), triOut: NSO_fuseTriCount(soups[0]), removed: 0 } };

  /* one tolerance for the whole chain, from the whole chain's extent -
     fusing pair by pair with a per-pair tolerance would let the threshold
     drift as the accumulated piece grows */
  var tolInfo = opts.tolInfo || NSO_fuseTolerance(soups, opts);
  var triIn = 0;
  for (var i = 0; i < soups.length; i++) triIn += NSO_fuseTriCount(soups[i]);

  var acc = soups[0], joints = [], removed = 0;
  for (i = 1; i < soups.length; i++) {
    var r = NSO_planarFusePair(acc, soups[i], { tolInfo: tolInfo });
    if (!r.ok) return { ok: false, reason: 'joint ' + i + ': ' + r.reason, jointIndex: i, joints: joints, tolInfo: tolInfo };
    acc = r.soup; joints.push(r.stats); removed += r.stats.removed;
  }
  return {
    ok: true, soup: acc, joints: joints, tolInfo: tolInfo,
    stats: { pieces: soups.length, triIn: triIn, triOut: NSO_fuseTriCount(acc), removed: removed, tol: tolInfo.tol, scale: tolInfo.scale }
  };
}

/* ---- signed volume (divergence theorem) --------------------------------- */
function NSO_soupVolume(soup) {
  var n = NSO_fuseTriCount(soup), v = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
    var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx));
  }
  return v / 6;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NSO_fuseTolerance: NSO_fuseTolerance, NSO_findSharedFace: NSO_findSharedFace,
    NSO_planarFusePair: NSO_planarFusePair, NSO_planarFuseChain: NSO_planarFuseChain,
    NSO_soupVolume: NSO_soupVolume, NSO_fuseTriCount: NSO_fuseTriCount,
    NSO_fuseVertGrid: NSO_fuseVertGrid
  };
}
