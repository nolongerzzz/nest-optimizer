// ===================== Crop, stage 1: remove a slab and rejoin =====================
// ===================== Crop, stage 2: move a region and reconnect it ================
// Sections 1-4 are headless: no DOM, no Three.js, no app state, so the same
// file runs under node (tools/nso_crop_test.js) and as a classic script in the
// browser. Section 4b (Move) is headless too, and also needs the boolean
// kernel and the field tools (tools/nso_crop_move_test.js). Section 5 is the
// app wiring and the movable box; 5b is Move's ghost and lock-in.
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
//   3. Repositioning. That is Stage 2, Move: sections 4b and 5b below.

/* =====================================================================
   1. Small helpers
   ===================================================================== */

var NSO_CROP_TOL = 1e-4;   // Cut's RAW_CUT_WELD_TOL; the checker's weld radius

function NSO_cropBounds(soup) {
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
   4b. Crop, stage 2: move a boxed region and reconnect it

   Headless, like sections 1-4, except that it needs the boolean kernel
   (NSO_unionSoups / NSO_subtractSoups / NSO_CSG, app-join.js) and the field
   tools (NSO_Thickness, NSO_Hollow). So it is async.

   A box selects a REGION: any box, not only a full slab. Stage 1's clip cuts
   it out (rawCut at each box face that crosses material). The region is moved
   by an offset, any direction, and at lock-in it is reconnected to the rest.
   HOW it is reconnected is decided by measuring the moved region against the
   rest, never by the offset the user typed:

     trim    they overlap. The union removes the overlap (NSO_unionSoups).
     touch   they meet face to face with no overlap to speak of. Same union.
     bridge  they do not touch. The gap is measured, and if it is within
             reach, a bridge is grown across it (a closing of the two parts,
             meshed by Hollow's surface nets) and unioned with both.
     refuse  the gap is wider than the bridge may reach; the region would be
             buried in the rest (almost all of its volume inside it); the move
             would leave the piece in more shells than it had; or the result
             fails the gate. Each refusal names its reason and hands back the
             input soup object untouched.

   WHERE THE KERNEL RUNS. Not on the whole piece. Measured on
   library/v9_mirror_factory.stl: a union over the whole piece keeps 39,228
   of the 39,230 triangles far from the joint, and the two it changes are
   the +seam's sub-tolerance pair, which the union's input weld merges; the
   weld below would reach the whole piece the same way. So only a SLAB along
   one axis goes through the kernel and the weld: the one that holds the box,
   the region where it lands and room for a bridge. The slab is cut out with
   rawCut (capped), reconnected, and spliced back into the untouched parts
   with Stage 1's own seal (NSO_cropSeal) after its caps are taken out,
   exactly as Crop seals a joint. Outside the slab every vertex is Cut's
   clipped half's (rawCutOpen), which is the input's except where Cut's own
   1e-4 weld merges a sub-tolerance pair. It is also the smaller job: the
   kernel, the gap search and the bridge field see thousands of triangles,
   not the piece's tens of thousands.

   NOTHING SMALLER THAN THE CHECKER'S WELD IS LEFT FOR IT TO MISREAD. That is
   the seam-cap defect class rawCut had (docs/MIRROR.md), and a move meets it
   twice on a Mirror-Join result:
     - The region carries the Join's seam-to-seam sliver fans (half of the
       v9 lip's triangles are under 1e-3 mm across). A union that cuts one
       leaves vertices closer than 1e-4, which the checker welds into
       non-manifold edges; and Cut's clip at the box faces leaves two fan
       triangles near-coplanar with no shared vertex, which the checker's
       float test reads as piercing. So the lifted region is re-meshed by the
       kernel before it moves (NSO_cropRegionSimplify): it is a closed piece
       on its own, nothing else has to match its outline.
     - The bridge's surface-nets vertices can land closer than 1e-4 after
       float32 rounding. So the reconnected slab is welded at Cut's own radius
       (rawWeldSoup, RAW_CUT_WELD_TOL), as rawCut finishes (NSO_cropWeldClean).
   Measured on v9. With neither, a landing on the teeth that crosses a slot
   wall came out non-manifold 2 -> 78. The weld alone fixes that, but leaves
   one near-coplanar fan pair in the moved lip that the checker's
   self-intersection pass calls piercing (disjoint in exact arithmetic); the
   re-mesh takes it out. With the re-mesh and without the weld, the bridged
   lip came out 2 -> 4 (tools/nso_crop_move_test.js section 5).
   ===================================================================== */

var NSO_CROP_MOVE = {
  maxGapMm: 3,        // widest gap a bridge is grown across
  maxBuried: 0.9,     // refuse when more than this share of the region lands inside the rest
  touchMm3: 1e-3,     // an overlap below this is a touch, not a trim
  marginMm: 1.5,      // slab margin past the zone the reconnection can reach
  pitchMin: 0.08,     // bridge field pitch, mm
  pitchMax: 0.15,
  maxNodes: 6e6       // bridge field size cap (the pitch grows to fit)
};

// Normalise a raw-frame box { min, max } to float32 planes. Null if unusable.
function NSO_cropMoveBox(box) {
  if (!box || !box.min || !box.max) return null;
  var min = [], max = [];
  for (var j = 0; j < 3; j++) {
    var a = Math.fround(box.min[j]), b = Math.fround(box.max[j]);
    if (!isFinite(a) || !isFinite(b) || !(b > a)) return null;
    min.push(a); max.push(b);
  }
  return { min: min, max: max };
}

// Connected pieces of a soup, joined through exact shared vertex positions.
function NSO_cropShellCount(soup) {
  var id = new Map(), parent = [];
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function vid(o) {
    var kk = soup[o] + ',' + soup[o+1] + ',' + soup[o+2];
    var v = id.get(kk);
    if (v === undefined) { v = parent.length; parent.push(v); id.set(kk, v); }
    return v;
  }
  for (var t = 0; t + 8 < soup.length; t += 9) {
    var a = find(vid(t)), b = find(vid(t + 3)), c = find(vid(t + 6));
    parent[b] = a; parent[find(c)] = a;
  }
  var roots = new Set();
  for (var i = 0; i < parent.length; i++) roots.add(find(i));
  return roots.size;
}

// A closed axis-aligned box soup, outward wound.
function NSO_cropBoxSoup(lo, hi) {
  var v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
           [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  var f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
           [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  var out = new Float32Array(f.length * 9), w = 0;
  f.forEach(function (t) { t.forEach(function (i) { out[w++] = v[i][0]; out[w++] = v[i][1]; out[w++] = v[i][2]; }); });
  return out;
}

/* The region: the piece inside the box, cut out with Cut's own clip.
   Along the splice axis first (it shrinks the soup most), then the others.
   A box face is cut only where it crosses material; a face past the piece
   cuts nothing. Sync, so the app can draw the region while it is moved.
   -> { ok, reason, tris (closed Float32Array), cuts } */
function NSO_cropRegionRaw(rawTris, box, axisIdx) {
  var out = { ok: false, reason: '', tris: null, cuts: 0 };
  var bx = NSO_cropMoveBox(box);
  if (!bx) { out.reason = 'the box needs min < max on every axis'; return out; }
  if (!rawTris || rawTris.length < 9) { out.reason = 'empty piece'; return out; }
  var k = (axisIdx === 0 || axisIdx === 1 || axisIdx === 2) ? axisIdx : 0;
  var order = [k, (k + 1) % 3, (k + 2) % 3];
  var cur = rawTris, tol = NSO_CROP_TOL;
  try {
    for (var n = 0; n < 3; n++) {
      var j = order[n];
      for (var side = 0; side < 2; side++) {
        var b = NSO_cropBounds(cur);
        var plane = side === 0 ? bx.min[j] : bx.max[j];
        if (!(plane > b.lo[j] + 2 * tol && plane < b.hi[j] - 2 * tol)) {
          if ((side === 0 && plane >= b.hi[j] - 2 * tol) || (side === 1 && plane <= b.lo[j] + 2 * tol)) {
            out.reason = 'the box holds no material of the piece'; return out;
          }
          continue;
        }
        // keepMin true keeps coord >= plane: the region is above its low face.
        cur = rawCut(cur, j, plane, side === 0);
        out.cuts++;
        if (!cur || cur.length < 9) { out.reason = 'the box holds no material of the piece'; return out; }
      }
    }
  } catch (err) {
    out.reason = 'the region could not be cut out (' + ((err && err.message) || err) + ')';
    return out;
  }
  if (!out.cuts) { out.reason = 'the box holds the whole piece - there is no rest to reconnect it to'; return out; }
  var cen = NSO_cropEdgeCensus(cur);
  if (cen.open || cen.repeated || cen.degenerate) {
    out.reason = 'the region did not come out closed (open ' + cen.open + ', repeated ' + cen.repeated + ')';
    return out;
  }
  out.ok = true;
  out.tris = cur instanceof Float32Array ? cur : new Float32Array(cur);
  return out;
}

function NSO_cropTranslate(soup, d) {
  var out = new Float32Array(soup.length);
  for (var i = 0; i < soup.length; i++) out[i] = soup[i] + d[i % 3];
  return out;
}

/* Shortest distance between two disjoint closed soups, both ways: every
   vertex of one against the other's surface (NSO_Thickness.prepare's
   nearest). Only vertices within reach of the other's bounds are asked. A
   vertex-to-face minimum; an edge-to-edge closest pair can make it read a
   little long, never short, so a bridge sized from it still spans. */
function NSO_cropGap(A, B, reach) {
  var TH = NSO_Thickness;
  var PA = TH.prepare(A, {}), PB = TH.prepare(B, {});
  var best = Infinity;
  function scan(src, P, other) {
    var b = NSO_cropBounds(other);
    for (var i = 0; i + 2 < src.length; i += 3) {
      if (src[i] < b.lo[0] - reach || src[i] > b.hi[0] + reach || src[i+1] < b.lo[1] - reach ||
          src[i+1] > b.hi[1] + reach || src[i+2] < b.lo[2] - reach || src[i+2] > b.hi[2] + reach) continue;
      var n = P.nearest([src[i], src[i+1], src[i+2]], Math.min(best, 2 * reach));
      if (n && n.dist < best) best = n.dist;
    }
  }
  scan(B, PA, A); scan(A, PB, B);
  return best;
}

/* The bridge across a gap g between closed soups A and B.

   A morphological CLOSING of A u B with a ball of radius r (dilate, then
   erode), kept only where it lies within g + r of BOTH parts. Where the two
   face each other across less than 2r, the closing fills the gap and rounds
   its edges with radius r; anywhere else it is A u B itself and the mask
   drops it. So the bridge is the gap and its fillets, reaching r into each
   part so the union has volume to grip, not a face to balance on.

   The field is Hollow's (nso_hollow.js), called, not copied: parity
   occupancy on +Z rays (NSO_Thickness.prepare().hitsAlong), the exact EDT
   (edt3d), the well-composed tidy (tidyPositive) and surface nets. The EDT
   measures node to node, so the closing is sampled at the pitch; that is
   the smoothing the bridge is for, and the union with the exact parts is
   what fixes its size.
   -> { ok, reason, soup, pitch, r, volume, nodes } */
function NSO_cropBridge(A, B, g, opts) {
  opts = opts || {};
  var C = NSO_CROP_MOVE, TH = NSO_Thickness, H = NSO_Hollow;
  var out = { ok: false, reason: '', soup: null };
  if (!H || typeof H.surfaceNets !== 'function') { out.reason = 'the field tools (nso_hollow.js) are not loaded'; return out; }
  var pitch = Math.min(C.pitchMax, Math.max(C.pitchMin, g / 3));
  var r = Math.max(0.6 * g, g / 2 + 2 * pitch, 0.4), reach = g + r;
  var ba = NSO_cropBounds(A), bb = NSO_cropBounds(B), lo = [], hi = [];
  for (var k = 0; k < 3; k++) {
    // Only where both parts are within reach: the overlap of their
    // reach-grown bounds, and never past both parts' own extent.
    lo[k] = Math.max(Math.max(ba.lo[k], bb.lo[k]) - reach, Math.min(ba.lo[k], bb.lo[k]));
    hi[k] = Math.min(Math.min(ba.hi[k], bb.hi[k]) + reach, Math.max(ba.hi[k], bb.hi[k]));
    if (!(hi[k] > lo[k])) { out.reason = 'the two parts do not face each other within reach'; return out; }
  }
  var n, guard = 0;
  for (;;) {
    n = [0, 1, 2].map(function (a) { return Math.ceil((hi[a] - lo[a]) / pitch) + 7; });
    if (n[0] * n[1] * n[2] <= C.maxNodes || guard++ > 60) break;
    pitch *= 1.2;
    r = Math.max(r, g / 2 + 2 * pitch); reach = g + r;
  }
  var nx = n[0], ny = n[1], nz = n[2], N = nx * ny * nz;
  // Nudged off the pitch lattice so no parity ray runs along a face (Hollow's reason).
  var jit = pitch * 0.01374;
  var org = [lo[0] - 3 * pitch + jit, lo[1] - 3 * pitch + jit, lo[2] - 3 * pitch + jit];
  // Parity rays start below BOTH parts, not below the grid: the grid can
  // begin inside a part, and a ray born inside reads every node inside out.
  var z0 = Math.min(ba.lo[2], bb.lo[2]) - 1, lead = org[2] - z0;
  function occupancy(P) {
    var o = new Uint8Array(N), span = lead + (nz - 1) * pitch + 1;
    for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
      var hits = P.hitsAlong([org[0] + i * pitch, org[1] + j * pitch, z0], [0, 0, 1], span);
      if (!hits.length) continue;
      var h = 0;
      for (var kk = 0; kk < nz; kk++) {
        var s = lead + kk * pitch;
        while (h < hits.length && hits[h] <= s) h++;
        if (h & 1) o[(kk * ny + j) * nx + i] = 1;
      }
    }
    return o;
  }
  function distTo(inside) {
    var seed = new Float64Array(N);
    for (var q = 0; q < N; q++) seed[q] = inside[q] ? 0 : 1e18;
    var d = H.edt3d(seed, nx, ny, nz);
    for (var q2 = 0; q2 < N; q2++) d[q2] = Math.sqrt(d[q2]) * pitch;
    return d;
  }
  var dA = distTo(occupancy(TH.prepare(A, {}))), dB = distTo(occupancy(TH.prepare(B, {})));
  var outside = new Uint8Array(N);
  for (var q = 0; q < N; q++) outside[q] = Math.min(dA[q], dB[q]) > r ? 1 : 0;
  var dC = distTo(outside);           // distance to what the dilation did not reach
  var F = new Float64Array(N), pos = 0;
  for (var kz = 0; kz < nz; kz++) for (var jy = 0; jy < ny; jy++) for (var ix = 0; ix < nx; ix++) {
    var id = (kz * ny + jy) * nx + ix;
    var v = Math.min(dC[id] - r, reach - dA[id], reach - dB[id]);
    if (ix < 1 || jy < 1 || kz < 1 || ix >= nx - 1 || jy >= ny - 1 || kz >= nz - 1) v = -pitch;
    F[id] = v;
    if (v > 0) pos++;
  }
  if (!pos) { out.reason = 'the closing found nothing to fill between the two parts'; return out; }
  var tidy = H.tidyPositive(F, nx, ny, nz, pitch, 27);
  var soup = H.surfaceNets(F, nx, ny, nz, org, pitch);
  if (!soup.length) { out.reason = 'the bridge came out with no surface'; return out; }
  var vol = H.signedVolume(soup, null);
  if (vol < 0) {
    for (var f = 0; f < soup.length; f += 9) for (var c = 0; c < 3; c++) {
      var t = soup[f + 3 + c]; soup[f + 3 + c] = soup[f + 6 + c]; soup[f + 6 + c] = t;
    }
    vol = -vol;
  }
  // Closed and consistently wound. A zero-area triangle (two cell vertices
  // that round to one float32 point) is left for the union's weld to merge;
  // the gate on the finished piece counts degenerates again.
  var cen = NSO_cropEdgeCensus(soup);
  if (cen.open || cen.repeated) {
    out.reason = 'the bridge surface is not closed (open ' + cen.open + ', repeated ' + cen.repeated + ')';
    return out;
  }
  out.degenerate = cen.degenerate;
  out.ok = true; out.soup = soup; out.pitch = pitch; out.r = r; out.volume = vol;
  out.nodes = N; out.tidied = tidy.critical; out.specks = tidy.specks;
  return out;
}

/* Weld the kernel's output at Cut's radius (rawWeldSoup, which drops what
   collapses) and split away any zero-area triangle, exactly as rawCut
   finishes. See the header of this section for why. Deliberately NOT the
   kernel's own Manifold.simplify on the slab: measured, it also collapses
   vertices on the slab's cap outline that lie within its tolerance of a straight line,
   and the far part still has them, so the splice finds a sliver of step
   face (v9, slab end at X 92.3065: 3 step edges). The weld alone fixed
   every landing simplify did, and leaves the outline alone, because rawCut
   already welded its on-plane points at twice this radius. */
function NSO_cropWeldClean(soup) {
  return rawSplitDegenerates(new Float32Array(rawWeldSoup(Array.from(soup), NSO_CROP_TOL)));
}

/* The lifted region, re-meshed by the kernel at Cut's radius
   (Manifold.simplify). A region is a closed piece on its own until lock-in,
   so here, unlike on the slab, there is no outline anything else must still
   match. On a Mirror-Join result it carries the Join's sliver fans, and Cut's
   clip at the box faces removes the seam vertex two of them shared. Their
   planes then differ by 1e-7 rad, and the checker's float triangle test
   reads the pair as piercing (docs/MIRROR.md, "checker limit"): measured on
   v9, one pair in the moved lip, disjoint in exact arithmetic. Simplifying
   the region takes the fans out (1370 -> 100 triangles on the v9 lip,
   -0.0075 mm^3). If the kernel does not hand back a closed piece, the region
   is used as cut. */
async function NSO_cropRegionSimplify(R) {
  var wasm = await NSO_CSG.load();
  var man = null, simp = null;
  try {
    man = NSO_CSG.soupToManifold(wasm, R);
    if (man.status && man.status() !== 'NoError') return R;
    simp = man.simplify(NSO_CROP_TOL);
    if (simp.status && simp.status() !== 'NoError') return R;
    var out = rawSplitDegenerates(NSO_CSG.manifoldToSoup(simp));
    var cen = NSO_cropEdgeCensus(out);
    return (cen.open || cen.repeated || cen.degenerate || out.length < 36) ? R : out;
  } catch (err) {
    return R;
  } finally {
    if (man) man.delete();
    if (simp) simp.delete();
  }
}

// Soup -> [[p,p,p], ...], leaving out triangles lying in any of `planes` on axis k.
function NSO_cropTrisOffPlanes(flat, k, planes) {
  var out = [], dropped = 0;
  for (var t = 0; t + 8 < flat.length; t += 9) {
    var v = [[flat[t], flat[t+1], flat[t+2]], [flat[t+3], flat[t+4], flat[t+5]], [flat[t+6], flat[t+7], flat[t+8]]];
    var inPlane = false;
    for (var p = 0; p < planes.length; p++) {
      if (v[0][k] === planes[p] && v[1][k] === planes[p] && v[2][k] === planes[p]) { inPlane = true; break; }
    }
    if (inPlane) { dropped++; continue; }
    out.push(v);
  }
  return { tris: out, dropped: dropped };
}

/* NSO_cropMoveRaw(rawTris, opts) -> Promise<{ ok, reason, tris, branch, ... }>

   opts.box      { min: [x,y,z], max: [x,y,z] } in the raw frame
   opts.offset   [dx, dy, dz], mm, raw frame: where the region goes
   opts.axisIdx  the splice axis (default: the piece's longest)
   opts.maxGapMm, opts.maxBuried   override NSO_CROP_MOVE
   Result: branch 'trim' | 'touch' | 'bridge'; overlapMm3, gapMm, bridgeMm3,
   buriedFrac (what was measured); slab { axisIdx, lo, hi } (null = not cut,
   the slab runs to that end); canonBefore / canonAfter (NSO_Repair.inspect).
   On refusal ok is false and tris is the input soup object. */
async function NSO_cropMoveRaw(rawTris, opts) {
  opts = opts || {};
  var C = NSO_CROP_MOVE, tol = NSO_CROP_TOL;
  var maxGap = opts.maxGapMm > 0 ? opts.maxGapMm : C.maxGapMm;
  var maxBuried = opts.maxBuried > 0 ? opts.maxBuried : C.maxBuried;
  var res = { ok: false, reason: '', tris: rawTris, branch: null };
  function refuse(why) { res.ok = false; res.reason = why; res.tris = rawTris; return res; }
  if (typeof NSO_unionSoups !== 'function' || typeof NSO_subtractSoups !== 'function' || typeof NSO_CSG === 'undefined') {
    return refuse('the boolean kernel (app-join.js) is not loaded');
  }
  if (typeof NSO_Thickness === 'undefined' || typeof NSO_Hollow === 'undefined') {
    return refuse('the field tools (nso_thickness.js, nso_hollow.js) are not loaded');
  }
  var d = opts.offset;
  if (!d || d.length !== 3 || !d.every(function (x) { return isFinite(x); })) return refuse('the move needs an offset [dx, dy, dz]');
  d = d.map(function (x) { return Math.fround(x); });
  res.offset = d;
  var bx = NSO_cropMoveBox(opts.box);
  if (!bx) return refuse('the box needs min < max on every axis');
  if (!(Math.hypot(d[0], d[1], d[2]) > tol)) return refuse('the region was not moved');

  var pb = NSO_cropBounds(rawTris);
  var k = opts.axisIdx;
  if (!(k === 0 || k === 1 || k === 2)) {
    k = 0;
    for (var a = 1; a < 3; a++) if (pb.hi[a] - pb.lo[a] > pb.hi[k] - pb.lo[k]) k = a;
  }
  res.axisIdx = k;

  // 1. The region, by Cut's clip.
  var reg = NSO_cropRegionRaw(rawTris, bx, k);
  if (!reg.ok) return refuse(reg.reason);
  var R = await NSO_cropRegionSimplify(reg.tris), volR = NSO_cropVolume(R);
  res.regionTris = R.length / 9; res.regionMm3 = volR;
  res.regionTrisCut = reg.tris.length / 9; res.regionSimplifyMm3 = volR - NSO_cropVolume(reg.tris);
  var Rp = NSO_cropTranslate(R, d);

  // 2. The slab through the kernel: the box, where the region lands, and
  //    room for a bridge on either side. A side that would reach the end of
  //    the piece is not cut at all.
  // The region's own extent is the notch it leaves; with the landing, the zone.
  var rb = NSO_cropBounds(R), zlo = Math.min(rb.lo[k], rb.lo[k] + d[k]), zhi = Math.max(rb.hi[k], rb.hi[k] + d[k]);
  var grow = 1.6 * maxGap + C.marginMm;
  var s0 = Math.fround(zlo - grow), s1 = Math.fround(zhi + grow);
  var cutLo = s0 > pb.lo[k] + 2 * tol, cutHi = s1 < pb.hi[k] - 2 * tol;
  res.slab = { axisIdx: k, lo: cutLo ? s0 : null, hi: cutHi ? s1 : null };
  var S = rawTris;
  try {
    if (cutLo) S = rawCut(S, k, s0, true);
    if (S && cutHi) S = rawCut(S, k, s1, false);
  } catch (err) { return refuse('the slab around the move could not be cut out (' + ((err && err.message) || err) + ')'); }
  if (!S || S.length < 9) return refuse('the slab around the move is empty');

  // 3. The rest of the slab: the slab minus the box. Box faces past the
  //    slab are pushed clear of it, so no face of the box lies on one of the
  //    slab's own.
  var sb = NSO_cropBounds(S), blo = [], bhi = [];
  for (var j = 0; j < 3; j++) {
    blo.push(bx.min[j] > sb.lo[j] ? bx.min[j] : sb.lo[j] - 1);
    bhi.push(bx.max[j] < sb.hi[j] ? bx.max[j] : sb.hi[j] + 1);
  }
  var sub = await NSO_subtractSoups(S, NSO_cropBoxSoup(blo, bhi));
  if (!sub.ok) return refuse('the region could not be lifted out of the rest (' + sub.reason + ')');
  var rest = sub.soup, volRest = NSO_cropVolume(rest);
  res.notchMm3 = sub.removedMm3;

  // 4. Measure, then branch on what was measured.
  var u = await NSO_unionSoups(rest, Rp);
  var merged;
  if (u.ok) {
    var overlap = volRest + volR - NSO_cropVolume(u.soup);
    res.overlapMm3 = Math.max(0, overlap);
    res.buriedFrac = res.overlapMm3 / volR;
    if (res.buriedFrac > maxBuried) {
      return refuse('the move buries the region: ' + (res.buriedFrac * 100).toFixed(0) + '% of it lands inside the rest (limit ' +
        (maxBuried * 100).toFixed(0) + '%), so nothing of it would be left to see');
    }
    res.branch = res.overlapMm3 > C.touchMm3 ? 'trim' : 'touch';
    res.gapMm = 0;
    merged = u.soup;
  } else if (/do not touch/.test(u.reason || '')) {
    // Measured out to three reaches, so a refusal can say how far it is.
    var look = 3 * maxGap + 1;
    var g = NSO_cropGap(rest, Rp, look);
    res.gapMm = g; res.overlapMm3 = 0;
    if (!(g <= maxGap)) {
      return refuse('the move leaves a gap of ' + (isFinite(g) ? g.toFixed(2) + ' mm' : 'more than ' + look + ' mm') +
        ' between the region and the rest; a bridge reaches ' + maxGap + ' mm at most');
    }
    var br = NSO_cropBridge(rest, Rp, g);
    if (!br.ok) return refuse('the ' + g.toFixed(2) + ' mm gap could not be bridged (' + br.reason + ')');
    res.bridge = { pitch: br.pitch, r: br.r, volume: br.volume, nodes: br.nodes, tris: br.soup.length / 9 };
    var u1 = await NSO_unionSoups(Rp, br.soup);
    if (!u1.ok) return refuse('the bridge does not reach the region (' + u1.reason + ')');
    var u2 = await NSO_unionSoups(rest, u1.soup);
    if (!u2.ok) return refuse('the bridge does not reach the rest (' + u2.reason + ')');
    res.bridgeMm3 = NSO_cropVolume(u2.soup) - volRest - volR;
    res.branch = 'bridge';
    merged = u2.soup;
  } else {
    return refuse('the kernel could not reconnect the region (' + u.reason + ')');
  }

  // opts.skipClean is for tools/nso_crop_move_test.js only: it shows what
  // the gate does with the kernel's raw output on a sliver-crossing landing.
  var clean = opts.skipClean ? rawSplitDegenerates(merged) : NSO_cropWeldClean(merged);
  res.slabMm3 = NSO_cropVolume(clean);
  res.cleanMm3 = res.slabMm3 - NSO_cropVolume(merged);   // what the weld moved, for the report

  // 5. Splice the slab back into the untouched parts with Stage 1's seal.
  var planes = [];
  if (cutLo) planes.push(s0);
  if (cutHi) planes.push(s1);
  var mid = NSO_cropTrisOffPlanes(clean, k, planes).tris;
  var want = res.slabMm3;
  res.splices = [];
  try {
    if (cutLo) {
      var near = rawCutOpen(rawTris, k, s0, false);
      if (!near) return refuse('nothing of the piece below the slab');
      want += NSO_cropOpenVolume(near, k, s0);
      var info0 = {};
      var joined = NSO_cropSeal(NSO_cropTrisOffPlanes(near, k, [s0]).tris, mid, k, s0, tol, info0);
      res.splices.push(info0);
      if (info0.capLoops) return refuse('the slab did not splice back at ' + 'XYZ'[k] + ' ' + s0 + ' (its section changed)');
      mid = NSO_cropTrisOffPlanes(joined, k, []).tris;
    }
    if (cutHi) {
      var far = rawCutOpen(rawTris, k, s1, true);
      if (!far) return refuse('nothing of the piece above the slab');
      want += NSO_cropOpenVolume(far, k, s1);
      var info1 = {};
      var joined1 = NSO_cropSeal(mid, NSO_cropTrisOffPlanes(far, k, [s1]).tris, k, s1, tol, info1);
      res.splices.push(info1);
      if (info1.capLoops) return refuse('the slab did not splice back at ' + 'XYZ'[k] + ' ' + s1 + ' (its section changed)');
      mid = NSO_cropTrisOffPlanes(joined1, k, []).tris;
    }
  } catch (err) { return refuse('the slab did not splice back (' + ((err && err.message) || err) + ')'); }
  var flat = [];
  mid.forEach(function (T) { flat.push(T[0][0], T[0][1], T[0][2], T[1][0], T[1][1], T[1][2], T[2][0], T[2][1], T[2][2]); });
  var out = rawSplitDegenerates(new Float32Array(flat));

  // 6. The gate, on the float32 values it will be saved as.
  var census = NSO_cropEdgeCensus(out);
  res.census = census;
  if (census.open || census.repeated || census.degenerate) {
    return refuse('the reconnected piece is not closed (open ' + census.open + ', repeated ' + census.repeated +
      ', degenerate ' + census.degenerate + ')');
  }
  var vol = NSO_cropVolume(out);
  res.volumeBefore = NSO_cropVolume(rawTris); res.volumeAfter = vol; res.volumeExpected = want;
  if (!(Math.abs(vol - want) <= 1e-5 * Math.max(1, Math.abs(want)))) {
    return refuse('the spliced piece encloses ' + vol + ' mm^3, its parts ' + want + ' mm^3');
  }
  var shellsIn = NSO_cropShellCount(rawWeldSoup(Array.from(rawTris), tol)), shellsOut = NSO_cropShellCount(out);
  res.shellsBefore = shellsIn; res.shellsAfter = shellsOut;
  if (shellsOut !== shellsIn) {
    return refuse('the move leaves the piece in ' + shellsOut + ' separate part(s) where it was ' + shellsIn);
  }
  // The exact-key census above cannot see a feature under the checker's
  // weld: two vertices 5e-5 apart are two keys, and closed. The checker
  // welds them and reads the fold as non-manifold. So where the in-page
  // checker is loaded (NSO_Repair.inspect, the transcription of
  // tools/mesh_validate.py that Solidify and Crop already gate on), the
  // result may carry nothing the input did not: no open edge, and no more
  // non-manifold, flipped or degenerate edges than it came in with.
  if (typeof NSO_Repair !== 'undefined' && NSO_Repair && typeof NSO_Repair.inspect === 'function') {
    var cb = NSO_Repair.inspect(rawTris, { selfIntersections: false });
    var ca = NSO_Repair.inspect(out, { selfIntersections: false });
    res.canonBefore = { open: cb.openEdges, nm: cb.nonManifoldEdges, flipped: cb.flippedEdges, degen: cb.degenerateTris, parts: cb.components };
    res.canonAfter = { open: ca.openEdges, nm: ca.nonManifoldEdges, flipped: ca.flippedEdges, degen: ca.degenerateTris, parts: ca.components };
    if (ca.openEdges || ca.nonManifoldEdges > cb.nonManifoldEdges || ca.flippedEdges > cb.flippedEdges ||
        ca.degenerateTris > cb.degenerateTris || ca.components !== cb.components) {
      return refuse('checker: open ' + ca.openEdges + ', non-manifold ' + cb.nonManifoldEdges + '→' + ca.nonManifoldEdges +
        ', flipped ' + cb.flippedEdges + '→' + ca.flippedEdges + ', degenerate ' + cb.degenerateTris + '→' + ca.degenerateTris +
        ', parts ' + cb.components + '→' + ca.components);
    }
  }
  res.ok = true;
  res.reason = '';
  res.tris = out;
  return res;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_cropRaw: NSO_cropRaw, NSO_cropResolveBox: NSO_cropResolveBox,
    NSO_cropEdgeCensus: NSO_cropEdgeCensus, NSO_cropVolume: NSO_cropVolume,
    NSO_cropRegionRaw: NSO_cropRegionRaw, NSO_cropMoveRaw: NSO_cropMoveRaw, NSO_cropBridge: NSO_cropBridge };
}

/* =====================================================================
   5. App wiring: the box, the button, the commit

   The Crop row lives in the Cut menu and works on the piece the cutter is
   on, along the cutter's axis (resolveAxis), so the box and the red line
   always agree about which way the piece runs. The box is given as two
   distances from the piece's low end, in the frame the Cut readout uses,
   and mapped to the raw frame with Cut's own mapPlaneToRaw.

   The box in the viewport is optional (the "Box" tick). It is drawn in the
   piece's own frame, so it follows any pose. Drag its body to slide it
   along the axis; drag either end face to move that end.

   PAINT SCOPE: WHOLE-PIECE, the same answer Extend gives. Every face past
   the box slides, so no face there can be promised untouched. Any paint
   stands the whole bake down, naming the count. nsoMaskCount(m) is the test.
   ===================================================================== */

var NSO_CROP_MIN_MM = 0.5;   // keep at least this much on each side, and in the box

function NSO_cropState() {
  if (typeof state === 'undefined') return {};
  if (!state.crop) state.crop = { startMm: null, endMm: null, show: false, forId: null };
  var cs = state.crop;
  // Stage 2 (Move): cross-section limits on the box, in mm from the piece's
  // low end along each display axis (null = the whole cross-section), and
  // the region's offset in the display frame (up is +Y).
  if (!cs.limits) cs.limits = { upFrom: null, upTo: null, acrossFrom: null, acrossTo: null };
  if (!cs.move) cs.move = [0, 0, 0];
  return cs;
}

// The slab in display terms for model m, defaulting to the middle fifth.
function NSO_cropDisplaySlab(m) {
  if (!m || !m.geometry || !m.geometry.attributes || !m.geometry.attributes.position) return null;
  var axis = resolveAxis(m);
  var bb = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  var origin = axis === 'x' ? bb.min.x : bb.min.z;
  var span = axis === 'x' ? bb.max.x - bb.min.x : bb.max.z - bb.min.z;
  if (!(span > 0)) return null;
  var cs = NSO_cropState();
  // A new piece, a new axis, or this piece's length changed under the box
  // (another bake): start again from the middle fifth.
  if (cs.forId !== m.id || cs.axis !== axis || !(cs.endMm <= span - NSO_CROP_MIN_MM)) {
    cs.forId = m.id; cs.axis = axis;
    cs.startMm = Math.round(span * 0.4 * 10) / 10;
    cs.endMm = Math.round(span * 0.6 * 10) / 10;
    cs.limits = { upFrom: null, upTo: null, acrossFrom: null, acrossTo: null };
    cs.move = [0, 0, 0];
    cs.lift = false;
  }
  return { axis: axis, bbox: bb, origin: origin, span: span, startMm: cs.startMm, endMm: cs.endMm };
}

// Display slab -> raw box. Null with a reason when the raw frame cannot be
// trusted to match what the user sees.
function NSO_cropRawBox(m, slab) {
  if (!m.rawTris || m.rawAxis !== 'zup' || !m.centerOffset) return { reason: 'Crop needs a raw piece' };
  var a = mapPlaneToRaw(m, slab.axis, slab.origin + slab.startMm, false);
  var b = mapPlaneToRaw(m, slab.axis, slab.origin + slab.endMm, false);
  if (!a || !b) return { reason: 'no raw mapping for this axis' };
  var k = a.axisIdx;
  var rb = NSO_cropBounds(m.rawTris);
  // Same check Split's raw engine relies on implicitly: the raw piece's
  // extent on this axis is the extent the user is looking at.
  if (Math.abs((rb.hi[k] - rb.lo[k]) - slab.span) > 1e-3) {
    return { reason: 'the piece was turned since it was loaded, so its raw frame no longer matches the view' };
  }
  var min = rb.lo.slice(), max = rb.hi.slice();
  min[k] = Math.min(a.plane, b.plane); max[k] = Math.max(a.plane, b.plane);
  return { box: { axisIdx: k, min: min, max: max } };
}

function NSO_cropReadout(m, slab) {
  var el = document.getElementById('crop-readout');
  if (!el) return;
  if (!m || !slab) { el.textContent = '—'; return; }
  var txt = 'Box ' + slab.axis.toUpperCase() + ' ' + slab.startMm.toFixed(1) + ' → ' + slab.endMm.toFixed(1) +
    ' mm (' + (slab.endMm - slab.startMm).toFixed(1) + ' mm out) → piece ' + slab.span.toFixed(1) + ' → ' +
    (slab.span - (slab.endMm - slab.startMm)).toFixed(1) + ' mm';
  var rb = NSO_cropRawBox(m, slab);
  if (rb.box) {
    var sel = NSO_cropResolveBox(m.rawTris, rb.box);
    if (sel.ok) txt += '. ' + sel.faces.removed + ' face(s) removed, ' + sel.faces.clipped + ' clipped';
    else txt += '. ' + sel.reason;
  }
  el.textContent = txt;
}

function NSO_cropSyncUI() {
  if (typeof document === 'undefined') return;
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  var slab = m ? NSO_cropDisplaySlab(m) : null;
  var s = document.getElementById('crop-start-mm'), e = document.getElementById('crop-end-mm');
  if (slab) {
    if (s && document.activeElement !== s) s.value = slab.startMm.toFixed(1);
    if (e && document.activeElement !== e) e.value = slab.endMm.toFixed(1);
  }
  var btn = document.getElementById('btn-crop');
  if (btn) btn.disabled = !(typeof state !== 'undefined' && state.cutterOpen && m);
  NSO_cropReadout(m, slab);
  NSO_cropUpdateHelper();
}

function NSO_cropSetEnds(startMm, endMm) {
  var m = getActiveModel();
  var slab = m && NSO_cropDisplaySlab(m);
  if (!slab) return;
  var cs = NSO_cropState();
  var lo = Math.max(NSO_CROP_MIN_MM, Math.min(startMm, slab.span - 2 * NSO_CROP_MIN_MM));
  var hi = Math.min(slab.span - NSO_CROP_MIN_MM, Math.max(endMm, lo + NSO_CROP_MIN_MM));
  cs.startMm = Math.round(lo * 10) / 10;
  cs.endMm = Math.round(hi * 10) / 10;
  NSO_cropSyncUI();
}

/* ---- the box in the viewport ------------------------------------------ */

function NSO_cropTargetMesh(m) {
  var placed = (state.placed || []).find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  return (placed && placed.mesh) || state.previewMesh || null;
}

function NSO_cropRemoveHelper() {
  var h = state.cropHelper;
  if (!h) return;
  if (h.parent) h.parent.remove(h);
  h.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  state.cropHelper = null;
}

function NSO_cropUpdateHelper() {
  if (typeof state === 'undefined' || !state.scene || typeof THREE === 'undefined') return;
  NSO_cropRemoveHelper();
  var cs = NSO_cropState();
  var m = getActiveModel();
  if (!cs.show || !state.cutterOpen || !m) return;
  var slab = NSO_cropDisplaySlab(m), mesh = NSO_cropTargetMesh(m);
  if (!slab || !mesh) return;
  var bb = slab.bbox, ax = slab.axis === 'x' ? 0 : 2;
  var size = [bb.max.x - bb.min.x + 2, bb.max.y - bb.min.y + 2, bb.max.z - bb.min.z + 2];
  var center = [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2];
  // Move's cross-section limits narrow the box on the other two axes.
  var dbox = NSO_cropDisplayBox(slab);
  [1, ax === 0 ? 2 : 0].forEach(function (a) {
    if (!dbox.limited[a]) return;
    size[a] = dbox.max[a] - dbox.min[a];
    center[a] = (dbox.min[a] + dbox.max[a]) / 2;
  });
  var len = slab.endMm - slab.startMm;
  size[ax] = len;
  center[ax] = slab.origin + (slab.startMm + slab.endMm) / 2;

  var g = new THREE.Group();
  g.name = 'cropHelper';
  var body = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.18, depthWrite: false }));
  body.userData.cropHandle = 'body';
  g.add(body);
  var edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry),
    new THREE.LineBasicMaterial({ color: 0xb91c1c }));
  g.add(edges);
  ['start', 'end'].forEach(function (which) {
    var fs = size.slice(); fs[ax] = Math.max(0.6, Math.min(2, len * 0.2));
    var face = new THREE.Mesh(new THREE.BoxGeometry(fs[0], fs[1], fs[2]),
      new THREE.MeshBasicMaterial({ color: 0xb91c1c, transparent: true, opacity: 0.45, depthWrite: false }));
    var p = [0, 0, 0]; p[ax] = (which === 'start' ? -1 : 1) * len / 2;
    face.position.set(p[0], p[1], p[2]);
    face.userData.cropHandle = which;
    g.add(face);
  });
  mesh.updateMatrixWorld(true);
  g.matrixAutoUpdate = false;
  g.matrix.copy(mesh.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(center[0], center[1], center[2]));
  g.matrixWorldNeedsUpdate = true;
  state.scene.add(g);
  state.cropHelper = g;
}

// Pointer -> distance from the piece's low end along the axis, measured in
// the piece's own frame on the horizontal plane through its centre.
function NSO_cropMmFromPointer(m, slab, mesh) {
  state.raycaster.setFromCamera(state.pointer, state.camera);
  mesh.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var ray = state.raycaster.ray.clone().applyMatrix4(inv);
  var cy = (slab.bbox.min.y + slab.bbox.max.y) / 2;
  var hit = new THREE.Vector3();
  if (!ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -cy), hit)) return null;
  return (slab.axis === 'x' ? hit.x : hit.z) - slab.origin;
}

if (typeof document !== 'undefined') {
  (function wireCrop() {
    var drag = null;
    function onDown(ev) {
      if (ev.button !== 0 || !state.cropHelper || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      var hits = state.raycaster.intersectObject(state.cropHelper, true)
        .filter(function (h) { return h.object.userData.cropHandle; });
      if (!hits.length) return;
      var m = getActiveModel(), slab = m && NSO_cropDisplaySlab(m), mesh = m && NSO_cropTargetMesh(m);
      if (!slab || !mesh) return;
      var at = NSO_cropMmFromPointer(m, slab, mesh);
      if (at == null) return;
      // The handle is where the NEAREST hit lands: within an end slab's
      // thickness of an end, that end; anywhere else, the body. (Any hit
      // further along the ray is behind the surface the user clicked.)
      state.cropHelper.updateMatrixWorld(true);
      var local = state.cropHelper.worldToLocal(hits[0].point.clone());
      var ax = slab.axis === 'x' ? 'x' : 'z';
      var half = (slab.endMm - slab.startMm) / 2;
      var grip = Math.max(0.6, Math.min(2, half * 0.4));
      var handle = local[ax] <= -half + grip ? 'start' : local[ax] >= half - grip ? 'end' : 'body';
      drag = { handle: handle, at: at, startMm: slab.startMm, endMm: slab.endMm };
      if (state.controls) state.controls.enabled = false;
      ev.stopPropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!drag) return;
      var m = getActiveModel(), slab = m && NSO_cropDisplaySlab(m), mesh = m && NSO_cropTargetMesh(m);
      if (!slab || !mesh) { drag = null; return; }
      setPointerFromEvent(ev);
      var at = NSO_cropMmFromPointer(m, slab, mesh);
      if (at == null) return;
      var d = at - drag.at;
      if (drag.handle === 'body') {
        var len = drag.endMm - drag.startMm;
        var s = Math.max(NSO_CROP_MIN_MM, Math.min(drag.startMm + d, slab.span - NSO_CROP_MIN_MM - len));
        NSO_cropSetEnds(s, s + len);
      } else if (drag.handle === 'start') {
        NSO_cropSetEnds(drag.startMm + d, drag.endMm);
      } else {
        NSO_cropSetEnds(drag.startMm, drag.endMm + d);
      }
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      if (state.controls) state.controls.enabled = true;
    }
    function wire() {
      var btn = document.getElementById('btn-crop');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try { NSO_cropSelectedModel(); }
        catch (err) {
          console.error('[crop]', err);
          setStatus('Crop failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      ['crop-start-mm', 'crop-end-mm'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () {
          var s = parseFloat(document.getElementById('crop-start-mm').value);
          var e = parseFloat(document.getElementById('crop-end-mm').value);
          if (isFinite(s) && isFinite(e)) NSO_cropSetEnds(s, e);
          else NSO_cropSyncUI();
        });
      });
      var chk = document.getElementById('chk-crop-box');
      if (chk) chk.addEventListener('change', function () { NSO_cropState().show = chk.checked; NSO_cropSyncUI(); });
      // Capture on the document, ahead of the canvas's own capture handler,
      // so a grab on the box never reaches select/move/orbit.
      document.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      // The box follows the cutter: same piece, same lifetime.
      if (typeof updateCutHelper === 'function') {
        var baseUpdate = updateCutHelper;
        updateCutHelper = function () { var r = baseUpdate.apply(this, arguments); NSO_cropSyncUI(); return r; };
      }
      if (typeof updateCutterUI === 'function') {
        var baseUI = updateCutterUI;
        updateCutterUI = function () { var r = baseUI.apply(this, arguments); NSO_cropSyncUI(); return r; };
      }
      NSO_cropSyncUI();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}

/* ---- the commit ---------------------------------------------------------- */

function NSO_cropCensus(soup) {
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair.inspect !== 'function') return null;
  try {
    var r = NSO_Repair.inspect(soup, { selfIntersections: false });
    return { open: r.openEdges, nm: r.nonManifoldEdges, degen: r.degenerateTris };
  } catch (e) { return null; }
}

function NSO_cropSelectedModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) { setStatus('Open the cutter and select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    setStatus('Crop stood down - ' + painted + ' painted face(s); everything past the box slides. Clear paint to crop.', true);
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var slab = NSO_cropDisplaySlab(m);
  if (!slab) { setStatus('Crop: this piece has no extent to crop', true); return { ok: false, reason: 'no extent' }; }
  var rb = NSO_cropRawBox(m, slab);
  if (!rb.box) { setStatus('Crop refused - piece unchanged (' + rb.reason + ')', true); return { ok: false, reason: rb.reason }; }
  var label = 'removed ' + slab.axis.toUpperCase() + ' ' + slab.startMm.toFixed(1) + '–' + slab.endMm.toFixed(1) + ' mm';
  var r = NSO_cropModel(m, rb.box, { label: label });
  if (r.ok) {
    var cs = NSO_cropState();
    cs.forId = null;               // the old box would now select other geometry
    NSO_cropSyncUI();
  }
  return r;
}

/* The commit, for any caller that already has a raw box: the Cut menu's Crop
   row above, and G-scope (app-microscope.js), which crops a Z band chosen on
   its layer-range slider. One gate and one commit, so the two cannot drift.
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

/* =====================================================================
   5b. App wiring for Move (Crop, stage 2): the region, the ghost, lock-in

   The Crop box picks the span along the cut axis, as before. Two more
   pairs of fields narrow it across the section: Up (display Y) and Across
   (the other horizontal axis), each in mm from the piece's low end on that
   axis, blank for the whole of it. What the box holds is the region.

   Tick Lift and the region is drawn as a ghost at its offset. Move it with
   the ΔX / ΔY / ΔZ fields (display axes, Y up) or drag the ghost: a drag
   moves it in the plane facing the camera, so turning the view and dragging
   again reaches any point in 3D. Nothing is changed until Lock in, which
   runs NSO_cropMoveRaw and commits through the sculpt commit (undo type
   cropMove). The branch - trim, touch or bridge - is the one measured at
   lock-in, and the status line says which it was and by how much.

   PAINT SCOPE: WHOLE-PIECE, as Crop. The slab the kernel rebuilds is chosen
   at lock-in, so no face can be promised untouched in advance.
   ===================================================================== */

function NSO_cropAcrossAxis(axis) { return axis === 'x' ? 2 : 0; }

// The box in the display frame: min / max per display axis, and which of
// the two cross axes the user limited.
function NSO_cropDisplayBox(slab) {
  var cs = NSO_cropState(), L = cs.limits || {};
  var bb = slab.bbox, lo = [bb.min.x, bb.min.y, bb.min.z], hi = [bb.max.x, bb.max.y, bb.max.z];
  var ax = slab.axis === 'x' ? 0 : 2, ac = NSO_cropAcrossAxis(slab.axis);
  var min = [lo[0] - 1, lo[1] - 1, lo[2] - 1], max = [hi[0] + 1, hi[1] + 1, hi[2] + 1], limited = [false, false, false];
  min[ax] = slab.origin + slab.startMm; max[ax] = slab.origin + slab.endMm;
  function lim(a, from, to) {
    if (from === null && to === null) return;
    var f = from === null ? -1 : from, t = to === null ? hi[a] - lo[a] + 1 : to;
    if (!(t > f)) return;
    min[a] = lo[a] + f; max[a] = lo[a] + t; limited[a] = true;
  }
  lim(1, L.upFrom, L.upTo);
  lim(ac, L.acrossFrom, L.acrossTo);
  return { min: min, max: max, limited: limited };
}

// Display box -> raw box. display = (x, z, -y) - centerOffset (the load
// transform, rawResultToDisplayGeometry), so raw x = X + off.x,
// raw z = Y + off.y, raw y = -(Z + off.z).
function NSO_cropMoveRawBox(m, slab) {
  if (!m.rawTris || m.rawAxis !== 'zup' || !m.centerOffset) return { reason: 'Move needs a raw piece' };
  var off = m.centerOffset, d = NSO_cropDisplayBox(slab), rb = NSO_cropBounds(m.rawTris), bb = slab.bbox;
  var ext = [[rb.hi[0] - rb.lo[0], bb.max.x - bb.min.x], [rb.hi[2] - rb.lo[2], bb.max.y - bb.min.y], [rb.hi[1] - rb.lo[1], bb.max.z - bb.min.z]];
  for (var i = 0; i < 3; i++) {
    if (Math.abs(ext[i][0] - ext[i][1]) > 1e-3) {
      return { reason: 'the piece was turned since it was loaded, so its raw frame no longer matches the view' };
    }
  }
  return {
    axisIdx: slab.axis === 'x' ? 0 : 1,
    box: {
      min: [d.min[0] + off.x, -(d.max[2] + off.z), d.min[1] + off.y],
      max: [d.max[0] + off.x, -(d.min[2] + off.z), d.max[1] + off.y]
    }
  };
}

function NSO_cropRawOffset(move) { return [move[0], -move[2], move[1]]; }

// The region for the current box, cut once per box and kept while it moves.
function NSO_cropCurrentRegion(m) {
  var slab = NSO_cropDisplaySlab(m);
  if (!slab) return { reason: 'this piece has no extent' };
  var rb = NSO_cropMoveRawBox(m, slab);
  if (!rb.box) return { reason: rb.reason };
  var cs = NSO_cropState();
  var key = m.id + '|' + rb.box.min.join(',') + '|' + rb.box.max.join(',');
  if (cs.regionKey !== key || cs.regionTrisRef !== m.rawTris) {
    if (cs.regionGeo) cs.regionGeo.dispose();
    cs.regionKey = key; cs.regionTrisRef = m.rawTris; cs.regionGeo = null;
    cs.region = NSO_cropRegionRaw(m.rawTris, rb.box, rb.axisIdx);
  }
  return { slab: slab, box: rb.box, axisIdx: rb.axisIdx, region: cs.region };
}

function NSO_cropRemoveGhost() {
  var g = state.cropGhost;
  if (!g) return;
  if (g.parent) g.parent.remove(g);
  if (g.material) g.material.dispose();
  state.cropGhost = null;
}

function NSO_cropUpdateGhost() {
  if (typeof state === 'undefined' || !state.scene || typeof THREE === 'undefined') return;
  var cs = NSO_cropState();
  var m = getActiveModel();
  if (!cs.lift || !state.cutterOpen || !m) { NSO_cropRemoveGhost(); return; }
  var cur = NSO_cropCurrentRegion(m), mesh = NSO_cropTargetMesh(m);
  if (!cur.region || !cur.region.ok || !mesh) { NSO_cropRemoveGhost(); return; }
  if (!cs.regionGeo) cs.regionGeo = rawResultToDisplayGeometry(cur.region.tris, m.centerOffset);
  var g = state.cropGhost;
  if (!g || g.geometry !== cs.regionGeo) {
    NSO_cropRemoveGhost();
    g = new THREE.Mesh(cs.regionGeo, new THREE.MeshStandardMaterial({
      color: 0xf59e0b, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5 }));
    g.name = 'cropGhost';
    g.userData.cropGhost = true;
    g.matrixAutoUpdate = false;
    state.scene.add(g);
    state.cropGhost = g;
  }
  mesh.updateMatrixWorld(true);
  g.matrix.copy(mesh.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(cs.move[0], cs.move[1], cs.move[2]));
  g.matrixWorldNeedsUpdate = true;
}

function NSO_cropMoveSyncUI() {
  if (typeof document === 'undefined') return;
  var cs = NSO_cropState(), L = cs.limits;
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  function put(id, v) {
    var el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = (v === null || v === undefined) ? '' : (+v).toFixed(id.indexOf('move') >= 0 ? 2 : 1);
  }
  put('crop-up-from', L.upFrom); put('crop-up-to', L.upTo);
  put('crop-across-from', L.acrossFrom); put('crop-across-to', L.acrossTo);
  put('crop-move-dx', cs.move[0]); put('crop-move-dy', cs.move[1]); put('crop-move-dz', cs.move[2]);
  var chk = document.getElementById('chk-crop-lift');
  if (chk) chk.checked = !!cs.lift;
  var el = document.getElementById('crop-move-readout'), btn = document.getElementById('btn-crop-lockin');
  var live = typeof state !== 'undefined' && state.cutterOpen && m;
  var ready = false, txt = '—';
  // The region is cut only once Lift is ticked: a Stage 1 box drag should not
  // pay for a clip it never uses.
  if (live && !cs.lift) txt = 'Narrow the box with Up / Across if you like, then tick Lift to move what it holds.';
  else if (live) {
    var cur = NSO_cropCurrentRegion(m);
    if (!cur.region) txt = cur.reason;
    else if (!cur.region.ok) txt = 'Region: ' + cur.region.reason;
    else {
      var moved = Math.hypot(cs.move[0], cs.move[1], cs.move[2]) > 0;
      txt = 'Region ' + NSO_cropVolume(cur.region.tris).toFixed(1) + ' mm³ (' + (cur.region.tris.length / 9) + ' faces), moved ΔX ' +
        cs.move[0].toFixed(2) + ' ΔY ' + cs.move[1].toFixed(2) + ' ΔZ ' + cs.move[2].toFixed(2) + ' mm' +
        (moved ? '. Lock in measures where it lands.' : '. Drag it or type an offset, then Lock in.');
      ready = moved;
    }
  }
  if (el) el.textContent = txt;
  if (btn) btn.disabled = !ready || !!state.cropMoveBusy;
  NSO_cropUpdateGhost();
}

function NSO_cropSetLimits(vals) {
  var cs = NSO_cropState();
  ['upFrom', 'upTo', 'acrossFrom', 'acrossTo'].forEach(function (k) {
    var v = vals[k];
    cs.limits[k] = (v === '' || v === null || v === undefined || !isFinite(+v)) ? null : Math.round(+v * 10) / 10;
  });
  NSO_cropSyncUI();
  NSO_cropMoveSyncUI();
}

function NSO_cropSetMove(d) {
  var cs = NSO_cropState();
  cs.move = [0, 1, 2].map(function (i) { var v = +d[i]; return isFinite(v) ? Math.round(v * 100) / 100 : 0; });
  NSO_cropMoveSyncUI();
}

async function NSO_cropMoveSelectedModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) { setStatus('Open the cutter and select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    setStatus('Move stood down - ' + painted + ' painted face(s); the slab it rebuilds is chosen at lock-in. Clear paint to move.', true);
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair.inspect !== 'function') {
    setStatus('Move unavailable - the mesh checker (NSO_Repair) is not loaded; piece unchanged', true);
    return { ok: false, reason: 'no checker' };
  }
  var cs = NSO_cropState();
  var cur = NSO_cropCurrentRegion(m);
  if (!cur.region) { setStatus('Move refused - piece unchanged (' + cur.reason + ')', true); return { ok: false, reason: cur.reason }; }
  if (!cur.region.ok) { setStatus('Move refused - piece unchanged (' + cur.region.reason + ')', true); return { ok: false, reason: cur.region.reason }; }
  var off = NSO_cropRawOffset(cs.move);
  state.cropMoveBusy = true;
  NSO_cropMoveSyncUI();
  setStatus('Move: measuring where the region lands and reconnecting it…');
  var r;
  try { r = await NSO_cropMoveRaw(m.rawTris, { box: cur.box, offset: off, axisIdx: cur.axisIdx }); }
  catch (err) { r = { ok: false, reason: (err && err.message) || String(err) }; }
  finally { state.cropMoveBusy = false; }
  if (!r.ok) {
    setStatus('Move refused - piece unchanged (' + r.reason + ')', true);
    NSO_cropMoveSyncUI();
    return r;
  }
  var how = r.branch === 'trim' ? 'landed ' + r.overlapMm3.toFixed(2) + ' mm³ into the piece, overlap trimmed'
    : r.branch === 'touch' ? 'landed face to face, joined'
    : 'landed ' + r.gapMm.toFixed(2) + ' mm clear, gap bridged (+' + r.bridgeMm3.toFixed(2) + ' mm³)';
  var txt = 'Move done - ' + how + '; one closed piece (open ' + r.canonAfter.open + ', non-manifold ' + r.canonAfter.nm + ')';
  NSO_sculptCommitRaw(m, r.tris, 'cropMove', txt);
  cs.lift = false; cs.move = [0, 0, 0]; cs.forId = null;
  NSO_cropRemoveGhost();
  NSO_cropSyncUI();
  NSO_cropMoveSyncUI();
  return r;
}

if (typeof document !== 'undefined') {
  (function wireCropMove() {
    var drag = null;
    // Window capture runs ahead of the box's document capture, so a grab on
    // the ghost never reaches the box, select, move or orbit.
    function onDown(ev) {
      if (ev.button !== 0 || !state.cropGhost || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      state.cropGhost.updateMatrixWorld(true);
      var hits = state.raycaster.intersectObject(state.cropGhost, false);
      if (!hits.length) return;
      var m = getActiveModel(), mesh = m && NSO_cropTargetMesh(m);
      if (!mesh) return;
      mesh.updateMatrixWorld(true);
      var n = new THREE.Vector3();
      state.camera.getWorldDirection(n);
      drag = { plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, hits[0].point), start: hits[0].point.clone(),
               move0: NSO_cropState().move.slice(), inv: new THREE.Matrix4().copy(mesh.matrixWorld).invert() };
      if (state.controls) state.controls.enabled = false;
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!drag) return;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      var p = new THREE.Vector3();
      if (!state.raycaster.ray.intersectPlane(drag.plane, p)) return;
      var a = drag.start.clone().applyMatrix4(drag.inv), b = p.applyMatrix4(drag.inv);
      NSO_cropSetMove([drag.move0[0] + b.x - a.x, drag.move0[1] + b.y - a.y, drag.move0[2] + b.z - a.z]);
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      if (state.controls) state.controls.enabled = true;
    }
    function wire() {
      var btn = document.getElementById('btn-crop-lockin');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        NSO_cropMoveSelectedModel().catch(function (err) {
          console.error('[crop move]', err);
          state.cropMoveBusy = false;
          setStatus('Move failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          NSO_cropMoveSyncUI();
        });
      });
      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      ['crop-up-from', 'crop-up-to', 'crop-across-from', 'crop-across-to'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () {
          NSO_cropSetLimits({ upFrom: val('crop-up-from'), upTo: val('crop-up-to'),
            acrossFrom: val('crop-across-from'), acrossTo: val('crop-across-to') });
        });
      });
      ['crop-move-dx', 'crop-move-dy', 'crop-move-dz'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () {
          NSO_cropSetMove([val('crop-move-dx'), val('crop-move-dy'), val('crop-move-dz')]);
        });
      });
      var chk = document.getElementById('chk-crop-lift');
      if (chk) chk.addEventListener('change', function () { NSO_cropState().lift = chk.checked; NSO_cropMoveSyncUI(); });
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      // Follow the Crop row: same piece, same lifetime, same box.
      var baseSync = NSO_cropSyncUI;
      NSO_cropSyncUI = function () { var r = baseSync.apply(this, arguments); NSO_cropMoveSyncUI(); return r; };
      NSO_cropMoveSyncUI();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
