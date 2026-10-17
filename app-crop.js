// ===================== Crop: the slab crop's engine, and its commit ==================
// What is left of Crop's first two stages. The CARD is app-crop-card.js, on the
// copy engine in nso_crop.js, and no longer takes a slab out of a piece; Move
// (stage 2) is gone from Crop (docs/CROP.md says where each job went). This file
// keeps the headless slab crop - NSO_cropRaw and the seal under it - because two
// callers still cut a slab and close the gap: G-scope's Crop on its layer range
// (app-microscope.js, through NSO_cropModel below) and Detach, whose cap on a
// flange's neck wall is NSO_cropSeal (nso_detach.js).
//
// Sections 1-4 are headless: no DOM, no Three.js, no app state, so the same
// file runs under node (tools/nso_crop_test.js) and as a classic script in the
// browser. Section 5 is the commit.
//
// Speaks rawTris, the flat triangle soup with 9 floats per triangle, in the
// raw (file) frame, the same soup Cut, Extend and Mirror pass around.
//
// WHAT IT DOES. A box selects a slab of the piece along one axis. Everything
// inside the slab goes. The part past the slab slides back along that axis by
// the slab's length, so it meets the near part at the near face, and the two
// are sealed into one closed piece. The piece comes out shorter by exactly the
// box length. That slide is part of "crop out a middle section", not a
// repositioning: nothing moves sideways or turns, and the near part does not
// move at all. Lining up two sections that do not match (a lateral offset, a
// twist) is Stage 2 and is not here.
//
// WHAT IT REUSES, and why it does not use the obvious two pieces:
//   - The clip at both box faces is Cut's own seam-safe clip, rawCutOpen in
//     app-cut.js: weld the input, snap near-plane vertices onto the plane,
//     clip, weld the on-plane points on their float32 positions. It is the
//     part of rawCut before the cap. rawCut is now rawCutOpen + the cap, so
//     the two tools cannot drift apart.
//   - Where a cap is needed, it is Cut's cap routine, rawFlatCapLoop (Cut's
//     ear clipper), fed a loop the same way rawCut feeds it.
//   - The finish is Cut's rawSplitDegenerates.
//   Measured, before writing any of this: capping both pieces with rawCut and
//   handing them to Join does not work. Join's planar fuse (NSO_planarFusePair)
//   refused a plain box, "no congruent triangle found". Each wall quad is two
//   triangles, and its diagonal crosses the two box faces at different points,
//   so the two sections have the same outline but different vertices on it.
//   The Manifold union (NSO_unionSoups) closed pin, the slotted block, the
//   star prism and the hinge. It left box_closed.stl and v9_mirror_factory.stl
//   non-manifold with inconsistent winding by tools/mesh_validate.py. So the
//   joint is sealed here, directly, on the two open boundaries (section 3).
//
// OUT OF SCOPE, refused by name rather than half-done:
//   1. A box that does not cover the whole cross-section. That would cut a
//      pocket, which is Carve's job. Crop removes full slabs only.
//   2. A joint whose step face would need a hole, e.g. the far section sits
//      wholly inside the near one without touching its outline. Cut's cap
//      routine fills simple loops only (a tube section is a known Cut
//      limitation). Two sections that are the same, tubes included, need no
//      cap and are fine.
//   3. Repositioning. That was Stage 2, Move, now gone: Crop copies, grab-drop
//      moves the copy, Join welds it (docs/CROP.md).

/* =====================================================================
   1. Small helpers
   ===================================================================== */

var NSO_CROP_TOL = 1e-4;   // Cut's RAW_CUT_WELD_TOL; the checker's weld radius

/* A big soup's box is kept (the cutter asks it on every blade move: 50 ms of
   vertex walk at 947,000 triangles). Keyed on the array, its length and a
   sample of its values, as the support planner keys its index on the same soup. */
var NSO_cropBoundsKept = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_cropBounds(soup) {
  var big = NSO_cropBoundsKept && soup.length >= 9 * 300000;
  if (big) {
    var kept = NSO_cropBoundsKept.get(soup), at = soup.length > 48 ? soup.length / 48 | 0 : 1, fp = soup.length;
    for (var q = 0; q < soup.length; q += at) fp += soup[q];
    if (kept && kept.fp === fp) return { lo: kept.lo.slice(), hi: kept.hi.slice() };
  }
  var r = NSO_cropBoundsWalk(soup);
  if (big) NSO_cropBoundsKept.set(soup, { fp: fp, lo: r.lo.slice(), hi: r.hi.slice() });
  return r;
}
function NSO_cropBoundsWalk(soup) {
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soup.length; i++) {
    var k = i % 3, v = soup[i];
    if (v < lo[k]) lo[k] = v;
    if (v > hi[k]) hi[k] = v;
  }
  return { lo: lo, hi: hi };
}

// Signed volume of a closed soup (divergence theorem about the origin).
function NSO_cropVolume(s) {
  var v = 0;
  for (var o = 0; o + 8 < s.length; o += 9) {
    v += s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7]) - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6]) +
         s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]);
  }
  return v / 6;
}

// Volume of an OPEN piece whose only opening lies in the plane coord[k] = c:
// the flux of F = (x_k - c) e_k, which is zero across that plane, so the
// missing cap adds nothing. Lets the gate know what the sealed result must
// enclose without building any cap to measure it.
function NSO_cropOpenVolume(s, k, c) {
  var v = 0;
  for (var o = 0; o + 8 < s.length; o += 9) {
    var a = o, b = o + 3, d = o + 6;
    var ux = s[b] - s[a], uy = s[b+1] - s[a+1], uz = s[b+2] - s[a+2];
    var vx = s[d] - s[a], vy = s[d+1] - s[a+1], vz = s[d+2] - s[a+2];
    var n = k === 0 ? uy * vz - uz * vy : k === 1 ? uz * vx - ux * vz : ux * vy - uy * vx;
    v += ((s[a+k] + s[b+k] + s[d+k]) / 3 - c) * n / 2;
  }
  return v;
}

// Exact-key edge census: every directed edge must occur once and its reverse
// once. That one test is closed + manifold + consistently wound, on the very
// float32 values an exported STL will carry.
function NSO_cropEdgeCensus(f32) {
  function pk(o) { return f32[o] + ',' + f32[o+1] + ',' + f32[o+2]; }
  var dir = new Map(), degenerate = 0;
  for (var t = 0; t + 8 < f32.length; t += 9) {
    var ka = pk(t), kb = pk(t + 3), kc = pk(t + 6);
    if (ka === kb || kb === kc || ka === kc) { degenerate++; continue; }
    var e = [ka + '>' + kb, kb + '>' + kc, kc + '>' + ka];
    for (var i = 0; i < 3; i++) dir.set(e[i], (dir.get(e[i]) || 0) + 1);
  }
  var open = 0, repeated = 0;
  dir.forEach(function (n, key) {
    if (n > 1) repeated += n - 1;
    var p = key.split('>');
    if (!dir.has(p[1] + '>' + p[0])) open++;
  });
  return { open: open, repeated: repeated, degenerate: degenerate, edges: dir.size };
}

/* =====================================================================
   2. The box: bounding box -> slab -> affected faces

   A box is { axisIdx, min: [x,y,z], max: [x,y,z] } in the raw frame, or just
   { axisIdx, lo, hi } for a slab whose sides are open. The box's extent on
   axisIdx is the slab. Every face the slab touches must lie inside the box's
   other two extents, otherwise the box is a pocket and is refused.

   faces: removed  - all three corners strictly inside the slab: deleted
          clipped  - crosses a box face: Cut's clip trims it
          kept     - untouched
   ===================================================================== */
function NSO_cropResolveBox(rawTris, box) {
  var out = { ok: false, reason: '' };
  if (!rawTris || rawTris.length < 9) { out.reason = 'empty piece'; return out; }
  if (!box || !(box.axisIdx === 0 || box.axisIdx === 1 || box.axisIdx === 2)) {
    out.reason = 'box needs an axis (0, 1 or 2)'; return out;
  }
  var k = box.axisIdx;
  var lo = box.min ? box.min[k] : box.lo, hi = box.max ? box.max[k] : box.hi;
  if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) { out.reason = 'box ends must be numbers with start < end'; return out; }
  // The planes are float32 values, so the joint face lands on a coordinate
  // an STL can hold and the far part's slide is exact at the joint.
  lo = Math.fround(lo); hi = Math.fround(hi);
  var b = NSO_cropBounds(rawTris);
  out.axisIdx = k; out.lo = lo; out.hi = hi; out.pieceLo = b.lo[k]; out.pieceHi = b.hi[k];
  var tol = NSO_CROP_TOL;
  if (!(lo > b.lo[k] + 2 * tol) || !(hi < b.hi[k] - 2 * tol)) {
    out.reason = 'the box must lie inside the piece along ' + 'XYZ'[k] + ' (' + b.lo[k] + ' .. ' + b.hi[k] +
      '); it runs ' + lo + ' .. ' + hi + '. A box over an end is a trim - use Cut';
    return out;
  }
  if (!(hi - lo > 2 * tol)) { out.reason = 'the box is thinner than the weld radius'; return out; }
  var removed = 0, clipped = 0, kept = 0, outside = 0;
  var o1 = (k + 1) % 3, o2 = (k + 2) % 3;
  for (var t = 0; t + 8 < rawTris.length; t += 9) {
    var c0 = rawTris[t + k], c1 = rawTris[t + 3 + k], c2 = rawTris[t + 6 + k];
    var mn = Math.min(c0, c1, c2), mx = Math.max(c0, c1, c2);
    if (mx < lo || mn > hi) { kept++; continue; }
    if (mn > lo && mx < hi) removed++; else clipped++;
    if (box.min && box.max) {
      for (var v = 0; v < 3; v++) {
        var p = t + v * 3;
        if (rawTris[p + o1] < box.min[o1] - tol || rawTris[p + o1] > box.max[o1] + tol ||
            rawTris[p + o2] < box.min[o2] - tol || rawTris[p + o2] > box.max[o2] + tol) { outside++; break; }
      }
    }
  }
  if (outside) {
    out.reason = 'the box does not cover the whole cross-section: ' + outside + ' face(s) in the slab reach outside it. ' +
      'Crop removes a full slab; a partial box would cut a pocket';
    return out;
  }
  out.faces = { removed: removed, clipped: clipped, kept: kept };
  out.ok = true;
  return out;
}

/* =====================================================================
   3. Sealing the joint

   After the slide both open boundaries lie in one plane, coord[k] = lo.
   Near part: region P, walls below. Far part: region Q, walls above.
   The sealed surface is
     - P and Q overlap: nothing. Those boundary edges pair up and the walls
       run straight through.
     - P outside Q: a step face on the near part, facing +k.
     - Q outside P: a step face on the far part, facing -k.
   Steps:
     a. weld the joint points of both parts together (2x Cut's weld radius,
        on float32 positions, as rawSnapPlanePoints does for one cut)
     b. split every open boundary edge at any joint point lying on it and at
        every crossing with the other part's boundary. The wall triangle that
        owns the edge is fanned from its off-plane corner, so no T-junction
        is left anywhere. This is what the planar fuse cannot do: it needs
        the two sections to have the same vertices, and a prism's two cuts
        never do.
     c. whatever edge still has no reverse twin borders a step face. Each is
        classed P-outside-Q or Q-outside-P by where its midpoint lies, walked
        into loops per class, and capped with Cut's rawFlatCapLoop.
   ===================================================================== */

function NSO_cropSeal(trisA, trisB, k, plane, tol, info) {
  var o1 = (k + 1) % 3, o2 = (k + 2) % 3;   // right-handed: o1 x o2 = +k
  function key(p) { return p[0] + ',' + p[1] + ',' + p[2]; }
  function onPlane(p) { return p[k] === plane; }
  var tris = [];                       // { v: [p,p,p], side: 0 near | 1 far }
  trisA.forEach(function (v) { tris.push({ v: v, side: 0 }); });
  trisB.forEach(function (v) { tris.push({ v: v, side: 1 }); });

  // a. weld the joint points of both parts
  var pts = [], seen = new Map();
  tris.forEach(function (T) {
    T.v.forEach(function (p) {
      if (!onPlane(p)) return;
      var kk = key(p);
      if (!seen.has(kk)) { seen.set(kk, pts.length / 3); pts.push(p[0], p[1], p[2]); }
    });
  });
  var rep = rawWeldPoints(pts, 2 * tol);
  var canon = new Map();
  seen.forEach(function (i, kk) {
    var r = rep[i];
    var q = [pts[r*3], pts[r*3+1], pts[r*3+2]];
    q[k] = plane;
    canon.set(kk, q);
  });
  var merged = 0;
  var welded = [];
  tris.forEach(function (T) {
    var v = T.v.map(function (p) {
      if (!onPlane(p)) return p;
      var q = canon.get(key(p));
      if (q !== p && key(q) !== key(p)) merged++;
      return q;
    });
    var a = key(v[0]), b = key(v[1]), c = key(v[2]);
    if (a === b || b === c || a === c) return;
    welded.push({ v: v, side: T.side });
  });
  tris = welded;
  info.jointPointsMerged = merged;

  function to2(p) { return [p[o1], p[o2]]; }
  function orient(a, b, c) { return (b[0]-a[0]) * (c[1]-a[1]) - (b[1]-a[1]) * (c[0]-a[0]); }

  // Directed on-plane edges with no reverse twin, over both parts together.
  function openEdges() {
    var dir = new Map();
    for (var i = 0; i < tris.length; i++) {
      var v = tris[i].v;
      for (var e = 0; e < 3; e++) {
        var a = v[e], b = v[(e+1)%3];
        if (!onPlane(a) || !onPlane(b)) continue;
        var kk = key(a) + '>' + key(b);
        var list = dir.get(kk);
        if (list) list.push([i, e]); else dir.set(kk, [[i, e]]);
      }
    }
    var open = [], repeated = 0;
    dir.forEach(function (list, kk) {
      if (list.length > 1) repeated += list.length - 1;
      var p = kk.split('>');
      if (dir.has(p[1] + '>' + p[0])) return;
      for (var j = 0; j < list.length; j++) {
        var T = tris[list[j][0]], e = list[j][1];
        open.push({ tri: list[j][0], e: e, a: T.v[e], b: T.v[(e+1)%3], side: T.side });
      }
    });
    return { open: open, repeated: repeated };
  }

  // b. split open edges at joint points on them and at crossings
  info.tJunctionSplits = 0; info.crossings = 0;
  var rounds = 0;
  for (;;) {
    if (++rounds > 64) throw new Error('joint split did not settle');
    var oe = openEdges();
    if (oe.repeated) {
      throw new Error('the two parts overlap along the joint (' + oe.repeated + ' repeated edge(s))');
    }
    var open = oe.open;
    if (!open.length) break;
    var jp = new Map();
    open.forEach(function (E) { jp.set(key(E.a), E.a); jp.set(key(E.b), E.b); });
    var jpl = Array.from(jp.values()).sort(function (p, q) { return p[o1] - q[o1]; });
    var jpu = jpl.map(function (p) { return p[o1]; });
    function firstAtLeast(u) {
      var l = 0, h = jpu.length;
      while (l < h) { var m = (l + h) >> 1; if (jpu[m] < u) l = m + 1; else h = m; }
      return l;
    }
    var splits = new Map();     // edge index -> [{p, t}]
    function addSplit(ei, p, t) {
      var L = splits.get(ei);
      if (!L) { L = []; splits.set(ei, L); }
      for (var i = 0; i < L.length; i++) if (key(L[i].p) === key(p)) return;
      L.push({ p: p, t: t });
    }
    // T-junctions: a joint point lying on an open edge, clear of its ends
    open.forEach(function (E, ei) {
      var a = to2(E.a), b = to2(E.b);
      var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
      var from = firstAtLeast(Math.min(a[0], b[0]) - tol);
      var umax = Math.max(a[0], b[0]) + tol;
      var vmin = Math.min(a[1], b[1]) - tol, vmax = Math.max(a[1], b[1]) + tol;
      for (var j = from; j < jpl.length && jpu[j] <= umax; j++) {
        var p = jpl[j], q = to2(p);
        if (q[1] < vmin || q[1] > vmax) continue;
        var s = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy);
        if (s * L <= tol * L2 || s * L >= L2 * L - tol * L2) continue;   // within tol of an end
        if (Math.abs(orient(a, b, q)) > tol * L) continue;               // off the line
        addSplit(ei, p, s / L2);
      }
    });
    var tCount = 0;
    splits.forEach(function (L) { tCount += L.length; });
    // Crossings between the near part's and the far part's open edges
    if (!tCount) {
      var A = [], B = [];
      open.forEach(function (E, ei) { (E.side === 0 ? A : B).push(ei); });
      for (var ia = 0; ia < A.length; ia++) {
        var Ea = open[A[ia]], a1 = to2(Ea.a), a2 = to2(Ea.b);
        var la = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
        for (var ib = 0; ib < B.length; ib++) {
          var Eb = open[B[ib]], b1 = to2(Eb.a), b2 = to2(Eb.b);
          if (Math.max(b1[0], b2[0]) < Math.min(a1[0], a2[0]) || Math.min(b1[0], b2[0]) > Math.max(a1[0], a2[0]) ||
              Math.max(b1[1], b2[1]) < Math.min(a1[1], a2[1]) || Math.min(b1[1], b2[1]) > Math.max(a1[1], a2[1])) continue;
          var lb = Math.hypot(b2[0] - b1[0], b2[1] - b1[1]);
          var d1 = orient(a1, a2, b1) / la, d2 = orient(a1, a2, b2) / la;
          var d3 = orient(b1, b2, a1) / lb, d4 = orient(b1, b2, a2) / lb;
          if (!((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol))) continue;
          if (!((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol))) continue;
          var t = d3 / (d3 - d4);
          var p = [0, 0, 0];
          p[k] = plane;
          p[o1] = Math.fround(a1[0] + (a2[0] - a1[0]) * t);
          p[o2] = Math.fround(a1[1] + (a2[1] - a1[1]) * t);
          var pq = to2(p);
          var ta = ((pq[0] - a1[0]) * (a2[0] - a1[0]) + (pq[1] - a1[1]) * (a2[1] - a1[1])) / (la * la);
          var tb = ((pq[0] - b1[0]) * (b2[0] - b1[0]) + (pq[1] - b1[1]) * (b2[1] - b1[1])) / (lb * lb);
          addSplit(A[ia], p, ta);
          addSplit(B[ib], p, tb);
          info.crossings++;
        }
      }
    }
    if (!splits.size) break;
    info.tJunctionSplits += tCount;
    // Fan each split edge's wall triangle from its off-plane corner.
    var drop = new Set(), add = [];
    splits.forEach(function (L, ei) {
      var E = open[ei];
      if (drop.has(E.tri)) return;          // a triangle has one on-plane edge
      L.sort(function (x, y) { return x.t - y.t; });
      var T = tris[E.tri], w = T.v[(E.e + 2) % 3];
      var chain = [E.a].concat(L.map(function (s) { return s.p; }), [E.b]);
      for (var i = 0; i + 1 < chain.length; i++) add.push({ v: [chain[i], chain[i+1], w], side: T.side });
      drop.add(E.tri);
    });
    tris = tris.filter(function (T, i) { return !drop.has(i); }).concat(add);
  }

  // c. class the edges still open, walk them into loops, cap each loop
  var rest = openEdges().open;
  info.stepEdges = rest.length;
  var caps = [];
  info.capLoops = 0; info.capTris = 0;
  if (rest.length) {
    // Each part's own outline, for point-in-region tests.
    var own = [[], []];
    var ownDir = [new Map(), new Map()];
    tris.forEach(function (T) {
      for (var e = 0; e < 3; e++) {
        var a = T.v[e], b = T.v[(e+1)%3];
        if (!onPlane(a) || !onPlane(b)) continue;
        ownDir[T.side].set(key(a) + '>' + key(b), [a, b]);
      }
    });
    [0, 1].forEach(function (s) {
      ownDir[s].forEach(function (ab, kk) {
        var p = kk.split('>');
        if (!ownDir[s].has(p[1] + '>' + p[0])) own[s].push([to2(ab[0]), to2(ab[1])]);
      });
    });
    function inside(q, outline) {
      var c = false;
      for (var i = 0; i < outline.length; i++) {
        var a = outline[i][0], b = outline[i][1];
        if ((a[1] > q[1]) !== (b[1] > q[1])) {
          var x = a[0] + (q[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
          if (x > q[0]) c = !c;
        }
      }
      return c;
    }
    // +1: near part outside the far one (step faces +k); -1: the reverse.
    var byClass = { '1': [], '-1': [] };
    rest.forEach(function (E) {
      var a = to2(E.a), b = to2(E.b), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      var inOther = inside(m, own[1 - E.side]);
      var cls = E.side === 0 ? (inOther ? -1 : 1) : (inOther ? 1 : -1);
      byClass[cls].push(E);
    });
    [1, -1].forEach(function (cls) {
      var edges = byClass[cls];
      if (!edges.length) return;
      var outs = new Map();
      edges.forEach(function (E, i) {
        var kk = key(E.a);
        var L = outs.get(kk);
        if (L) L.push(i); else outs.set(kk, [i]);
      });
      var used = new Uint8Array(edges.length);
      for (var s = 0; s < edges.length; s++) {
        if (used[s]) continue;
        var loop = [], cur = s, guard = 0;
        while (!used[cur] && guard++ <= edges.length) {
          used[cur] = 1;
          var E = edges[cur];
          loop.push(E.a);
          var cand = (outs.get(key(E.b)) || []).filter(function (j) { return !used[j] || j === s; });
          if (!cand.length) { cur = -1; break; }
          if (cand.length > 1) {
            // Two step faces of one class touch at this point. Keep to the
            // face being walked: the next edge is the one that turns least
            // away from it (face on the right for +1 in wall order, left
            // for -1; see the header of this section).
            var r = to2(E.a), pb = to2(E.b);
            var ra = Math.atan2(r[1] - pb[1], r[0] - pb[0]);
            var best = -1, bestAng = Infinity;
            cand.forEach(function (j) {
              var q = to2(edges[j].b);
              var ang = Math.atan2(q[1] - pb[1], q[0] - pb[0]) - ra;
              if (cls < 0) ang = -ang;
              while (ang <= 0) ang += 2 * Math.PI;
              while (ang > 2 * Math.PI) ang -= 2 * Math.PI;
              if (ang < bestAng) { bestAng = ang; best = j; }
            });
            cur = best;
          } else cur = cand[0];
        }
        if (cur !== s) throw new Error('a step-face outline at the joint does not close');
        if (loop.length < 3) throw new Error('a step-face outline at the joint has ' + loop.length + ' point(s)');
        // Wall order runs clockwise seen from +k for a +k face, counter-
        // clockwise for a -k face. A loop the other way round is a hole.
        var area = 0;
        for (var i = 0; i < loop.length; i++) {
          var p = to2(loop[i]), q = to2(loop[(i + 1) % loop.length]);
          area += p[0] * q[1] - q[0] * p[1];
        }
        area /= 2;
        if (area * cls > 0) {
          throw new Error('the joint needs a step face with a hole in it (the far section sits inside the near one ' +
            'or the reverse); Cut’s cap fills simple outlines only');
        }
        var cap = rawFlatCapLoop(loop, k, plane, cls < 0);
        var capArea = 0;
        for (var c = 0; c < cap.length; c += 9) {
          var A2 = to2([cap[c], cap[c+1], cap[c+2]]), B2 = to2([cap[c+3], cap[c+4], cap[c+5]]), C2 = to2([cap[c+6], cap[c+7], cap[c+8]]);
          capArea += Math.abs(orient(A2, B2, C2)) / 2;
        }
        if (Math.abs(capArea - Math.abs(area)) > 1e-6 * Math.max(1, Math.abs(area))) {
          throw new Error('a step face did not triangulate cleanly (cap ' + capArea + ' vs outline ' + Math.abs(area) + ' mm^2)');
        }
        caps.push(cap);
        info.capLoops++;
        info.capTris += cap.length / 9;
      }
    });
  }

  var out = [];
  tris.forEach(function (T) { out.push(T.v[0][0], T.v[0][1], T.v[0][2], T.v[1][0], T.v[1][1], T.v[1][2], T.v[2][0], T.v[2][1], T.v[2][2]); });
  caps.forEach(function (cap) { for (var i = 0; i < cap.length; i++) out.push(cap[i]); });
  return out;
}

/* =====================================================================
   4. NSO_cropRaw(rawTris, opts) -> { ok, reason, tris, ... }

   opts.box    a box as in section 2, or
   opts.axisIdx, opts.lo, opts.hi   the slab directly.
   opts.shells the input is several closed shells that may share faces
               (a toolpath's beads); see the gate below.
   On refusal ok is false and tris is the input soup object.
   ===================================================================== */
function NSO_cropRaw(rawTris, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: rawTris };
  var box = opts.box || { axisIdx: opts.axisIdx, lo: opts.lo, hi: opts.hi };
  var sel = NSO_cropResolveBox(rawTris, box);
  res.box = sel;
  if (!sel.ok) { res.reason = sel.reason; return res; }
  var k = sel.axisIdx, lo = sel.lo, hi = sel.hi, d = hi - lo, tol = NSO_CROP_TOL;
  res.axisIdx = k; res.axis = 'xyz'[k]; res.lo = lo; res.hi = hi; res.removedLength = d;
  res.faces = sel.faces;

  // Cut's own clip at both box faces. keepMin true keeps coord >= plane.
  var near = rawCutOpen(rawTris, k, lo, false);
  var far = rawCutOpen(rawTris, k, hi, true);
  if (!near || !far) { res.reason = 'a side of the box keeps nothing'; return res; }
  // A triangle lying IN a box face survives rawCutOpen only when it faces the
  // removed side (rawSnapPlanePoints): a flat face of the piece the box face
  // lands on, or seam slivers snapped onto it. Either way it is already cap,
  // i.e. part of that side's section, not wall. Take it out and the section
  // outline is the open boundary again, as for any other box face. It adds
  // nothing to the open volume below, since x_k - c is 0 on it.
  function toTris(flat, plane) {
    var out = [], inPlane = 0;
    for (var t = 0; t + 8 < flat.length; t += 9) {
      var v = [[flat[t], flat[t+1], flat[t+2]], [flat[t+3], flat[t+4], flat[t+5]], [flat[t+6], flat[t+7], flat[t+8]]];
      if (v[0][k] === plane && v[1][k] === plane && v[2][k] === plane) { inPlane++; continue; }
      out.push(v);
    }
    return { tris: out, inPlane: inPlane };
  }
  var A = toTris(near, lo), B = toTris(far, hi);
  res.inPlaneDropped = A.inPlane + B.inPlane;
  if (!A.tris.length || !B.tris.length) { res.reason = 'a side of the box keeps nothing'; return res; }
  var volNear = NSO_cropOpenVolume(near, k, lo), volFar = NSO_cropOpenVolume(far, k, hi);

  // Slide the far part back by the box length. The planes are float32, so
  // hi - d is exactly lo: the far joint lands on the near joint bit for bit.
  B.tris.forEach(function (v) {
    for (var i = 0; i < 3; i++) {
      var p = v[i].slice();
      p[k] = p[k] === hi ? lo : Math.fround(p[k] - d);
      v[i] = p;
    }
  });

  var info = {};
  var sealed;
  try { sealed = NSO_cropSeal(A.tris, B.tris, k, lo, tol, info); }
  catch (err) { res.reason = (err && err.message) || String(err); res.joint = info; return res; }
  res.joint = info;
  var out = rawSplitDegenerates(new Float32Array(sealed));

  // Gate on the result, on the float32 values it will be saved as.
  var census = NSO_cropEdgeCensus(out);
  res.census = census;
  // opts.shells: the input is a SET of closed shells that touch, not one
  // closed piece - a toolpath's beads (G-scope, app-microscope.js), where
  // buildLineGeometry emits one closed box per move and stacked layers and
  // collinear moves share faces exactly. Such a soup already carries repeated
  // directed edges before Crop touches it, so "no repeated edge" can never
  // hold. The gate becomes: still closed, nothing degenerate, and no MORE
  // repeated edges than the input brought - Crop may not add any. The volume
  // gate below is unchanged: it is a sum over shells either way.
  var allowRepeated = 0;
  if (opts.shells) {
    res.inputCensus = NSO_cropEdgeCensus(rawTris);
    allowRepeated = res.inputCensus.repeated;
  }
  if (census.open || census.repeated > allowRepeated || census.degenerate) {
    res.reason = 'the sealed piece is not closed (open ' + census.open + ', repeated ' + census.repeated +
      ', degenerate ' + census.degenerate + ')';
    return res;
  }
  var vol = NSO_cropVolume(out), want = volNear + volFar;
  res.volumeBefore = NSO_cropVolume(rawTris); res.volumeAfter = vol; res.volumeExpected = want;
  if (!(Math.abs(vol - want) <= 1e-5 * Math.max(1, Math.abs(want)))) {
    res.reason = 'the sealed piece encloses ' + vol + ' mm^3, the two kept parts ' + want + ' mm^3';
    return res;
  }
  var bIn = NSO_cropBounds(rawTris), bOut = NSO_cropBounds(out);
  res.lengthBefore = bIn.hi[k] - bIn.lo[k];
  res.lengthAfter = bOut.hi[k] - bOut.lo[k];
  res.ok = true;
  res.tris = out;
  return res;
}

/* =====================================================================
   5. The commit
   ===================================================================== */

/* ---- the commit ---------------------------------------------------------- */

function NSO_cropCensus(soup) {
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair.inspect !== 'function') return null;
  try {
    var r = NSO_Repair.inspect(soup, { selfIntersections: false });
    return { open: r.openEdges, nm: r.nonManifoldEdges, degen: r.degenerateTris };
  } catch (e) { return null; }
}

/* The commit, for any caller that already has a raw box: G-scope
   (app-microscope.js), which crops a Z band chosen on its layer-range slider.
     m      a model with rawTris ('zup')
     box    { axisIdx, lo, hi } or { axisIdx, min, max } in m's raw frame
     opts.shells  see NSO_cropRaw
     opts.label   what the status line says was removed
   Refusals leave the piece untouched and say why. */
function NSO_cropModel(m, box, opts) {
  opts = opts || {};
  if (!m || !m.rawTris) { setStatus('Crop needs a raw piece', true); return { ok: false, reason: 'no raw piece' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    setStatus('Crop stood down - ' + painted + ' painted face(s); everything past the box slides. Clear paint to crop.', true);
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var r = NSO_cropRaw(m.rawTris, { box: box, shells: !!opts.shells });
  if (!r.ok) { setStatus('Crop refused - piece unchanged (' + r.reason + ')', true); return r; }
  // The in-page transcription of the canonical checker, as Solidify gates.
  var before = NSO_cropCensus(m.rawTris), after = NSO_cropCensus(r.tris);
  r.canonBefore = before; r.canonAfter = after;
  if (!after) {
    setStatus('Crop unavailable - the mesh checker (NSO_Repair) is not loaded; piece unchanged', true);
    r.ok = false; r.reason = 'no checker'; return r;
  }
  if (after.open || after.nm > before.nm || after.degen > before.degen) {
    r.ok = false;
    r.reason = 'checker: open ' + after.open + ', non-manifold ' + before.nm + '→' + after.nm +
      ', degenerate ' + before.degen + '→' + after.degen;
    setStatus('Crop refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var cap = r.joint.capLoops ? r.joint.capLoops + ' step face(s) capped' : 'sections matched, no cap needed';
  var txt = 'Crop done - ' + (opts.label || ('removed ' + 'XYZ'[r.axisIdx] + ' ' + r.lo.toFixed(2) + '–' + r.hi.toFixed(2) + ' mm')) +
    '; piece ' + r.lengthBefore.toFixed(2) + ' → ' + r.lengthAfter.toFixed(2) +
    ' mm, ' + (opts.shells ? 'closed shells' : 'one closed piece') + ' (' + cap + '; open 0, non-manifold ' + after.nm + ')';
  NSO_sculptCommitRaw(m, r.tris, 'cropReplace', txt);
  return r;
}
