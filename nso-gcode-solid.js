/*
 * NSO toolpath -> solid: G-scope's real, ordered moves swept into closed shells
 * ============================================================================
 *
 * WHAT THIS IS
 *
 * The toolpath view draws one flat prism per extrusion move
 * (`NSOGcodeLines.extrudeFlatLine`, 12 triangles). Two prisms that meet at a
 * corner overlap on the inside of the turn and leave a notch on the outside,
 * and every move is its own closed box, so a selection of N moves is N shells
 * with 2N caps, most of them buried inside the bead. Turning that into one
 * solid by boolean-unioning the prisms is the expensive, fragile route.
 *
 * This file takes the other one. The parser already knows the ORDER the
 * nozzle drew the moves in and, since this file, where it genuinely stopped
 * (`mv.run`, see nso-gcode-lines.js). So each continuous stretch of bead is
 * handed, as the polyline it is, to the one sweep primitive the app already
 * has - `NSO_PathSweep.sweep`, the mitred sweep the round and tapered support
 * branches are built with - and comes out as ONE closed, 2-manifold shell with
 * exact mitred corners and a cap only where the bead really begins and ends.
 * Within a run there is no union, and nothing to heal afterwards.
 *
 * WHAT DECIDES A CAP
 *
 * A chain of moves continues while ALL of these hold between a move and the
 * one before it (`chainsOf`):
 *
 *   same run       the parser saw no travel, wipe, retraction, Z move or
 *                  G92 reposition between them - the nozzle never stopped
 *   next index     the move directly after it in the file is also in the
 *                  selection (a selection that skips a move cuts the bead
 *                  there - the solid is of what was selected)
 *   touching       it starts exactly where the last one ended, at the same
 *                  printing Z and layer height (defensive: a run the parser
 *                  calls continuous always passes this, and the check says so)
 *
 * and a FEATURE change does not break it: a bead that turns from Inner wall to
 * Outer wall without stopping is one bead.
 *
 * Then per chain, in this order:
 *
 *   1. SEAM CLOSURE. A perimeter stops just short of where it started - the
 *      slicer's seam gap, 0.09 mm on `supportwithinsupport` - which is a
 *      genuine stop. Capping it as one faithfully leaves the end cap sitting
 *      INSIDE the bead's own start, and the shell pierces itself there (the
 *      audit measures it: every such loop fails the pierce check). So a chain
 *      of 3+ moves that ends within half a bead width of its own start is
 *      swept as a CLOSED loop (`NSO_PathSweep.sweepClosed`) through its start
 *      point, with no caps at all. That adds exactly `A * gap` of volume per
 *      loop, which is counted (`stats.seamAddedMm3`) rather than hidden.
 *   2. OPEN SWEEP, capped at both real ends, if closing fails or does not
 *      apply.
 *   3. FORCED SPLIT, only where the sweep refuses: a bead that turns back on
 *      itself tighter than its own width (a zig-zag infill connector shorter
 *      than the bead is wide) overlaps ITSELF, and a single manifold shell of
 *      that shape cannot exist without a union. The chain is cut at the joint
 *      the sweep names and each side is swept on its own. Every such cut is
 *      recorded with the sweep's own reason (`stats.forcedSplits`), counted
 *      apart from real stops, never folded into them.
 *
 * THE CROSS-SECTION
 *
 * The same rectangle the toolpath view draws: `width` across, `height` tall,
 * top at the nozzle Z. One section per chain - a sweep is constant-section -
 * at the length-weighted mean width of its moves, which keeps
 * sum(width * height * length) exactly, so the solid's volume equals the
 * toolpath view's volume (plus the seam closures, minus nothing). The spread
 * of widths inside a chain is measured and reported (`stats.worstWidthSpread`)
 * so a chain whose moves disagree is visible rather than silently averaged.
 *
 * A mitred sweep with its profile centred on the path encloses exactly
 * (section area) x (centreline length): what the outside of each corner gains
 * the inside loses, linearly across a symmetric section. So the volume check
 * is exact, not approximate - see tools/gcode-test/gscope-solid-check.js.
 *
 * THEN, FOR AN EXPORT, A UNION WHERE RUNS TOUCH - AND ONLY THERE. buildSolid's
 * chains are separate closed shells; beads that touch (one layer on the next)
 * or overlap (neighbouring perimeters the slicer spaced closer than their
 * width) are shells in contact. `fuseShells` (below) unions exactly those
 * contacts with the app's own kernel, leaves every run's sweep as it is, and
 * passes a run that touches nothing through bit for bit. The live solid VIEW
 * does not fuse: it redraws on every slider step, and the union is an
 * export-time cost.
 *
 * No third-party dependencies; runs in the page and under Node.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSOGcodeSolid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function sweepLib() {
    var S = root && root.NSO_PathSweep;
    if (!S && typeof require === 'function') S = require('./nso_path_sweep.js');
    if (!S) throw new Error('NSO_PathSweep is not loaded - it owns the sweep');
    return S;
  }

  // ===========================================================================
  // chains - where a bead genuinely starts and stops
  // ===========================================================================

  /**
   * Split a set of parsed moves into continuous chains, in print order.
   *
   * @param {object[]} moves   parsed moves (any order; sorted by index here)
   * @returns {{moves: object[], startedBy: string}[]}  `startedBy` is why the
   *          chain before it ended: 'first', 'run' (the nozzle stopped),
   *          'selection' (the next move is not selected) or 'discontinuous'
   */
  function chainsOf(moves) {
    var list = (moves || []).filter(function (m) { return m && m.width > 0 && m.height > 0; });
    list.sort(function (a, b) { return a.index - b.index; });
    var chains = [];
    var cur = null, prev = null;
    for (var i = 0; i < list.length; i++) {
      var mv = list[i];
      var why = null;
      if (!prev) why = 'first';
      else if (mv.run == null || mv.run !== prev.run) why = 'run';
      else if (mv.index !== prev.index + 1) why = 'selection';
      else if (mv.x0 !== prev.x1 || mv.y0 !== prev.y1 || mv.z !== prev.z || mv.height !== prev.height) {
        why = 'discontinuous';
      }
      if (why) { cur = { moves: [], startedBy: why }; chains.push(cur); }
      cur.moves.push(mv);
      prev = mv;
    }
    return chains;
  }

  // ===========================================================================
  // one chain -> one or more closed shells
  // ===========================================================================

  function rectProfile(w, h) {
    // (r, s): r is up (the frame is seeded with +Z and every joint of a flat
    // chain turns about Z, so it stays up), s is across. CCW, origin inside.
    var a = h / 2, b = w / 2;
    return [[-a, -b], [a, -b], [a, b], [-a, b]];
  }

  // ===========================================================================
  // the bead crossing itself - the one thing the sweep cannot see
  // ===========================================================================
  //
  // `NSO_PathSweep.sweep` proves its output sound LOCALLY: rings are convex,
  // every rail runs forward, so neighbouring segments never cross. It knows
  // nothing about segment 3 and segment 40 of the same path. A bead that
  // crosses its own earlier line - a grid infill printed as one run, a tight
  // zig-zag - comes out as one shell that pierces itself, which the canonical
  // checker rightly fails. Found by sampling shells through
  // tools/mesh_validate.py, not by argument.
  //
  // A chain is flat (one printing Z, one height), so two segments of it
  // overlap in 3D exactly when their XY footprints do. Each footprint is the
  // quad between the segment's two rings - a convex trapezoid, because the
  // rails advance - so the test is a 2D separating-axis test between
  // non-adjacent quads, over a uniform grid. Quads nearer than `margin`
  // count as overlapping too: that is the validator's own weld radius, inside
  // which two walls of one shell would be welded into one non-manifold edge.

  var OVERLAP_MARGIN = 1e-4;   // mm - tools/mesh_validate.py's WELD_TOL

  function footprints(rings, closed) {
    // Rails 0 and 3 of the rectangle profile are the two bottom corners, one
    // each side (rectProfile); their XY is the footprint's edge.
    var N = rings.length, quads = [];
    var nSeg = closed ? N : N - 1;
    for (var k = 0; k < nSeg; k++) {
      var A = closed ? rings[(k + N - 1) % N] : rings[k];
      var B = closed ? rings[k] : rings[k + 1];
      quads.push([[A[0][0], A[0][1]], [B[0][0], B[0][1]], [B[3][0], B[3][1]], [A[3][0], A[3][1]]]);
    }
    return quads;
  }

  function separated(P, Q, margin) {
    var polys = [P, Q];
    for (var pi = 0; pi < 2; pi++) {
      var poly = polys[pi];
      for (var e = 0; e < poly.length; e++) {
        var a = poly[e], b = poly[(e + 1) % poly.length];
        var nx = b[1] - a[1], ny = a[0] - b[0];
        var L = Math.hypot(nx, ny);
        if (!(L > 0)) continue;
        nx /= L; ny /= L;
        var minP = Infinity, maxP = -Infinity, minQ = Infinity, maxQ = -Infinity;
        for (var i = 0; i < P.length; i++) { var dp = P[i][0] * nx + P[i][1] * ny; if (dp < minP) minP = dp; if (dp > maxP) maxP = dp; }
        for (var j = 0; j < Q.length; j++) { var dq = Q[j][0] * nx + Q[j][1] * ny; if (dq < minQ) minQ = dq; if (dq > maxQ) maxQ = dq; }
        if (maxP + margin <= minQ || maxQ + margin <= minP) return true;
      }
    }
    return false;
  }

  /**
   * The first segment j that overlaps an earlier, non-adjacent segment i of
   * the same sweep, as { i, j }, or null. "First" is smallest j, so cutting
   * the path at j's start leaves 0..j-1 free of any such pair.
   */
  function firstOverlap(rings, closed, margin) {
    var quads = footprints(rings, closed);
    var n = quads.length;
    if (n < 3) return null;
    var boxes = quads.map(function (q) {
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      q.forEach(function (p) {
        if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1];
        if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1];
      });
      return b;
    });
    var cell = 0;
    boxes.forEach(function (b) { cell = Math.max(cell, b[2] - b[0], b[3] - b[1]); });
    cell = Math.max(cell / 4, 1e-3);
    var grid = new Map();
    function cellsOf(b, fn) {
      var x0 = Math.floor((b[0] - margin) / cell), x1 = Math.floor((b[2] + margin) / cell);
      var y0 = Math.floor((b[1] - margin) / cell), y1 = Math.floor((b[3] + margin) / cell);
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) fn(x + ',' + y);
    }
    for (var j = 0; j < n; j++) {
      var hit = -1;
      var seen = {};
      cellsOf(boxes[j], function (key) {
        var list = grid.get(key);
        if (!list) return;
        for (var t = 0; t < list.length; t++) {
          var i = list[t];
          if (seen[i] || hit >= 0) continue;
          seen[i] = 1;
          if (j - i < 2) continue;                              // neighbours share a ring
          if (closed && i === 0 && j === n - 1) continue;       // ... round the loop too
          var bi = boxes[i], bj = boxes[j];
          if (bi[2] + margin <= bj[0] || bj[2] + margin <= bi[0] ||
              bi[3] + margin <= bj[1] || bj[3] + margin <= bi[1]) continue;
          if (!separated(quads[i], quads[j], margin)) hit = i;
        }
      });
      if (hit >= 0) return { i: hit, j: j };
      cellsOf(boxes[j], function (key) {
        var list = grid.get(key);
        if (!list) grid.set(key, list = []);
        list.push(j);
      });
    }
    return null;
  }

  function signedVolume(tris, from, to) {
    var v = 0;
    for (var t = from; t < to; t += 9) {
      var ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
      var bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
      var cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
      v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return v / 6;
  }

  /**
   * Sweep one chain. Returns { pieces: [{tris, closed, moveIds, pathLength}],
   * splits: [{moveIndex, reason}], dropped, seamGap, width, height, spread }.
   */
  function sweepChain(chain, opts) {
    opts = opts || {};
    var S = sweepLib();
    var mvs = chain.moves;
    var h = mvs[0].height;
    var zc = mvs[0].z - h / 2;               // bead centre: top is the nozzle Z
    var sumWL = 0, sumL = 0, wMin = Infinity, wMax = 0;
    for (var i = 0; i < mvs.length; i++) {
      sumWL += mvs[i].width * mvs[i].length;
      sumL += mvs[i].length;
      if (mvs[i].width < wMin) wMin = mvs[i].width;
      if (mvs[i].width > wMax) wMax = mvs[i].width;
    }
    var w = sumWL / sumL;
    var profile = rectProfile(w, h);
    var up = [0, 0, 1];

    // Path points, one per move end, with the move that ENDS at each. A step
    // too short for the float32 grid to give a direction (the parser keeps any
    // move over 1e-9 mm) is folded into its neighbour; that and nothing else
    // is dropped, and it is counted.
    var pts = [[mvs[0].x0, mvs[0].y0, zc]];
    var ends = [mvs[0].index];               // move that ends at each point (first: starts)
    var dropped = 0;
    for (var k = 0; k < mvs.length; k++) {
      var p = [mvs[k].x1, mvs[k].y1, zc];
      var q = pts[pts.length - 1];
      var floor = 64 * Math.max(S.ulp32(Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]))),
                                S.ulp32(Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))));
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= floor) {
        dropped++;
        if (pts.length > 1) { pts[pts.length - 1] = p; ends[ends.length - 1] = mvs[k].index; }
        continue;
      }
      pts.push(p);
      ends.push(mvs[k].index);
    }

    var out = { pieces: [], splits: [], dropped: dropped, seamGap: 0, width: w, height: h,
                spread: wMax > 0 ? (wMax - wMin) / w : 0 };
    if (pts.length < 2) return out;

    // 1. seam closure
    if (opts.closeSeams !== false && pts.length >= 4) {
      var first = pts[0], last = pts[pts.length - 1];
      var gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
      if (gap <= w / 2) {
        var loop = pts.slice(0, pts.length - 1);
        var prevPt = loop[loop.length - 1];
        // The closing step continues the last move when it is (near) collinear
        // with it - the usual seam - and is then folded into that move, so the
        // joint the sweep sees at the start point is the real corner there and
        // not a sliver of seam gap. Otherwise the last point stays a corner.
        var lx = last[0] - prevPt[0], ly = last[1] - prevPt[1];
        var gx = first[0] - last[0], gy = first[1] - last[1];
        var ll = Math.hypot(lx, ly), gl = Math.hypot(gx, gy);
        var collinear = gl === 0 || (Math.abs(lx * gy - ly * gx) <= 1e-6 * ll * gl && (lx * gx + ly * gy) > 0);
        if (!collinear) loop.push(last);
        if (loop.length >= 3) {
          var cl = S.sweepClosed({ points: loop, profile: profile, up: up });
          var clash = cl.ok ? firstOverlap(cl.rings, true, OVERLAP_MARGIN) : null;
          if (clash) {
            cl = { ok: false, reason: 'the loop crosses itself: segment ' + clash.j + ' overlaps segment ' + clash.i };
          }
          if (cl.ok) {
            out.seamGap = gap;
            out.pieces.push({ tris: cl.tris, closed: true, moveIds: mvs.map(function (m) { return m.index; }),
                              pathLength: cl.stats.pathLength });
            return out;
          }
          out.closeRefused = cl.reason;
        }
      }
    }

    // 2./3. open sweep, split where the sweep refuses
    (function go(a, b) {                       // points a..b inclusive
      if (b - a < 1) return;
      var sw = S.sweep({ points: pts.slice(a, b + 1), profile: profile, up: up });
      if (sw.ok) {
        var clash = firstOverlap(sw.rings, false, OVERLAP_MARGIN);
        if (clash) {
          // Cut where the crossing segment starts: 0..j-1 are clear of each
          // other by construction of "first", and each side is re-swept and
          // re-checked, so a cut that changes a ring is checked again too.
          var at = a + clash.j;
          out.splits.push({ moveIndex: ends[at], reason: 'the bead crosses itself: segment ' + clash.j +
                            ' of the run overlaps segment ' + clash.i + ', ' + (clash.j - clash.i - 1) +
                            ' segment(s) earlier - one shell of that shape would pierce itself' });
          go(a, at);
          go(at, b);
          return;
        }
        // Moves ending at points a+1..b, and the chain's first move when the
        // piece starts at the chain's start.
        var ids = [];
        for (var t = 0; t < mvs.length; t++) {
          var ix = mvs[t].index;
          if ((ix > ends[a] || (a === 0 && t === 0)) && ix <= ends[b]) ids.push(ix);
        }
        out.pieces.push({ tris: sw.tris, closed: false, moveIds: ids, pathLength: sw.stats.pathLength });
        return;
      }
      var fa = sw.failAt || {};
      var cut;
      if (fa.point != null) cut = a + fa.point;
      else if (fa.segment != null) cut = a + fa.segment + (fa.segment === 0 ? 1 : 0);
      if (cut == null || cut <= a || cut >= b) {
        // Nowhere interior to cut: a single segment the sweep will not take.
        // Cannot happen for a 2-point path over the float32 floor; say so if it does.
        out.splits.push({ moveIndex: ends[a], reason: 'unsweepable: ' + sw.reason });
        return;
      }
      out.splits.push({ moveIndex: ends[cut], reason: sw.reason });
      go(a, cut);
      go(cut, b);
    })(0, pts.length - 1);
    return out;
  }

  // ===========================================================================
  // a whole selection
  // ===========================================================================

  /**
   * The solid for a set of moves: one closed shell per continuous chain (more
   * only where the sweep forced a split), as one Z-up triangle soup in the
   * same format `NSOGcodeLines.buildLineGeometry` returns.
   *
   * @param {object[]} moves
   * @param {object} [opts]  { closeSeams: true, cache: Map }
   * @returns {{positions: Float32Array, shells: object[], stats: object}}
   */
  function buildSolid(moves, opts) {
    opts = opts || {};
    var chains = chainsOf(moves);
    var parts = [], shells = [];
    var total = 0;
    var stats = {
      moves: 0, chains: chains.length, shells: 0, closedLoops: 0, openShells: 0,
      starts: { first: 0, run: 0, selection: 0, discontinuous: 0 },
      forcedSplits: [], closeRefused: 0, droppedSteps: 0,
      seamGaps: 0, seamAddedMm3: 0,
      worstWidthSpread: 0,
      toolpathVolume: 0, solidVolume: 0, expectedVolume: 0
    };
    chains.forEach(function (ch) {
      stats.starts[ch.startedBy]++;
      stats.moves += ch.moves.length;
      for (var i = 0; i < ch.moves.length; i++) {
        var m = ch.moves[i];
        stats.toolpathVolume += m.width * m.height * m.length;
      }
      // A chain is fixed by its first and last move (its moves are contiguous
      // by construction), so a caller that rebuilds often - G-scope's solid
      // view, on every slider step - can hand in a Map and pay once per chain.
      var key = ch.moves[0].index + ':' + ch.moves[ch.moves.length - 1].index;
      var r = opts.cache ? opts.cache.get(key) : null;
      if (!r) {
        r = sweepChain(ch, opts);
        r.volumes = r.pieces.map(function (pc) { return signedVolume(pc.tris, 0, pc.tris.length); });
        if (opts.cache) opts.cache.set(key, r);
      }
      if (r.closeRefused) stats.closeRefused++;
      stats.droppedSteps += r.dropped;
      if (r.spread > stats.worstWidthSpread) stats.worstWidthSpread = r.spread;
      r.splits.forEach(function (s) { stats.forcedSplits.push(s); });
      var A = r.width * r.height;
      if (r.seamGap > 0) { stats.seamGaps++; stats.seamAddedMm3 += A * r.seamGap; }
      r.pieces.forEach(function (pc, pi) {
        var vol = r.volumes[pi];
        shells.push({
          triStart: total / 9, triCount: pc.tris.length / 9,
          closed: pc.closed, moveIds: pc.moveIds,
          feature: ch.moves[0].feature, layer: ch.moves[0].layer,
          width: r.width, height: r.height, pathLength: pc.pathLength,
          volume: vol
        });
        stats.expectedVolume += A * pc.pathLength;
        stats.solidVolume += vol;
        if (pc.closed) stats.closedLoops++; else stats.openShells++;
        parts.push(pc.tris);
        total += pc.tris.length;
      });
    });
    var positions = new Float32Array(total);
    var o = 0;
    parts.forEach(function (t) { positions.set(t, o); o += t.length; });
    stats.shells = shells.length;
    return { positions: positions, shells: shells, stats: stats };
  }

  /** Shell that a triangle of `built.positions` belongs to, or -1. */
  function shellOfTriangle(built, tri) {
    var sh = built.shells, lo = 0, hi = sh.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tri < sh[mid].triStart) hi = mid - 1;
      else if (tri >= sh[mid].triStart + sh[mid].triCount) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  // ===========================================================================
  // fusing a selection - a union only where two runs genuinely touch
  // ===========================================================================
  //
  // buildSolid makes every continuous run ONE sound shell and stops there, so
  // a selection spanning several runs is several shells in contact: 45 stacked
  // wall loops share a face per layer, and an inner wall overlaps the outer
  // wall beside it by the slicer's squish. `fuseShells` makes those contacts
  // one solid, and only those: the shells go in exactly as the sweep made
  // them, a shell that touches nothing comes out bit for bit, and the boolean
  // is the app's own kernel (NSO_CSG, app-join.js), called once per real
  // junction - never one N-way union over everything. The audit and every
  // number below: docs/GCODE-MICROSCOPE.md, "Fused selections".
  //
  // WHERE TWO RUNS MEET. A bead is a flat prism, top at f32(z), bottom at
  // f32(z - h), and there are exactly two ways two of them touch:
  //
  //   side    their Z bands overlap with thickness - same layer, or a thick
  //           bridge bead reaching down into the one below - and their
  //           footprints touch or overlap: neighbouring perimeters the slicer
  //           spaced closer than their width, the two pieces of a forced
  //           split meeting at the cut.
  //   stack   one's bottom plane IS the other's top plane and their footprints
  //           overlap with area. Meeting only along a line or at a corner is
  //           not a junction (the kernel keeps such pairs apart, measured), so
  //           it is never asked.
  //
  // Every contact found is a real one: all 16,542 of supportwithinsupport's,
  // unioned pair by pair, merge.
  //
  // THE PLANE SNAP. The sweep puts every vertex exactly on f32(z) or
  // f32(z - h), but f32(z_N - h) is not always f32(z_(N-1)) - the same nominal
  // plane, rounded twice. 181 of supportwithinsupport's 1,190 shells sit one
  // float32 step (9.5e-7 mm) above the top they rest on, which the kernel
  // reads as "do not touch". So a bottom within PLANE_SNAP_MM of another
  // shell's top is moved onto it - bottom vertices only, on a copy, only in
  // a group being fused.
  //
  // WHAT THE KERNEL HANDS BACK, and what is done with it:
  //
  //   slivers   components of no volume, left where coincident coplanar faces
  //             meet once both sides of a union are already unions. Dropped
  //             and counted (under SLIVER_MM3; the smallest real bead piece is
  //             0.015 mm^3). Counted as parts, they refused real junctions.
  //   cavities  components of NEGATIVE volume: air the beads enclose - walls
  //             round a pocket of sparse infill, closed over above. Part of
  //             their body, kept, counted (189 in supportwithinsupport).
  //   float32   each group's body is written to float32 ONCE, then finished by
  //             the tree's own cleanup for that write (_finishUnion).
  //
  // THE GATE. A fused body is exported only if the canonical checker passes
  // it (NSO_Defects.locate, the browser copy of tools/mesh_validate.py).
  // Three ways are tried per group (LADDER, below) and where none passes,
  // the beads AT the defects the checker located are set aside, as swept,
  // and the rest is fused - so a spot the kernel cannot write soundly costs
  // the junctions of the few beads that meet there, not the whole group.

  var PLANE_SNAP_MM = 1e-5;   // ~10 float32 steps at 100 mm; a layer step is >= 0.05
  var BOND_MM = 1e-3;         // a 'seated' bead reaches this far into the one below: 1/300 of
                              // a 0.3 mm layer, 10x the checker's 1e-4 weld so it is never
                              // welded shut, 30 float32 steps even at z = 500 mm
  var CONTACT_MM = 1e-6;      // a footprint must reach this far into another to count
  var BLAME_MM = 0.01;        // a defect is blamed on every bead whose footprint is this close
  var MAX_DEPTH = 12;         // set-asides and splits per group, at most
  var MAX_SHELLS = 4000;      // runs fused in one go (supportwithinsupport whole: 1,190)
  var MAX_JUNCTIONS = 20000;  // junctions fused in one go (supportwithinsupport whole: 16,542, ~27 s)
  var SLIVER_MM3 = 1e-6;      // a kernel component under this is a flat sliver, not a bead:
                              // the smallest real piece measured is 0.015 mm^3

  function treeFinish() {
    var T = root && root.NSO_SupportTree;
    if (!T && typeof require === 'function') {
      try { T = require('./nso_support_tree.js'); } catch (e) { T = null; }
    }
    return T && typeof T._finishUnion === 'function' ? T._finishUnion : null;
  }

  /** One shell's Z band and top-face footprint (triangles, XY only). */
  function shellFootprint(t) {
    var top = -Infinity, bot = Infinity;
    for (var k = 2; k < t.length; k += 3) { if (t[k] > top) top = t[k]; if (t[k] < bot) bot = t[k]; }
    var tris = [], boxes = [], area = 0;
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (var o = 0; o < t.length; o += 9) {
      if (t[o + 2] !== top || t[o + 5] !== top || t[o + 8] !== top) continue;
      var P = [[t[o], t[o + 1]], [t[o + 3], t[o + 4]], [t[o + 6], t[o + 7]]];
      var b = [Math.min(P[0][0], P[1][0], P[2][0]), Math.min(P[0][1], P[1][1], P[2][1]),
               Math.max(P[0][0], P[1][0], P[2][0]), Math.max(P[0][1], P[1][1], P[2][1])];
      tris.push(P); boxes.push(b);
      area += Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])) / 2;
      if (b[0] < bb[0]) bb[0] = b[0]; if (b[1] < bb[1]) bb[1] = b[1];
      if (b[2] > bb[2]) bb[2] = b[2]; if (b[3] > bb[3]) bb[3] = b[3];
    }
    return { top: top, bot: bot, tris: tris, boxes: boxes, box: bb, area: area };
  }

  /** Do two footprints meet? margin > 0: touching counts; margin < 0: they must overlap by -margin. */
  function footprintsMeet(A, B, margin) {
    var m = Math.max(margin, 0);
    for (var i = 0; i < A.tris.length; i++) {
      var a = A.boxes[i];
      if (a[2] + m < B.box[0] || B.box[2] + m < a[0] || a[3] + m < B.box[1] || B.box[3] + m < a[1]) continue;
      for (var j = 0; j < B.tris.length; j++) {
        var b = B.boxes[j];
        if (a[2] + m < b[0] || b[2] + m < a[0] || a[3] + m < b[1] || b[3] + m < a[1]) continue;
        if (!separated(A.tris[i], B.tris[j], margin)) return true;
      }
    }
    return false;
  }

  /** Is (x, y) within r of a footprint (inside one of its triangles, or near one)? */
  function nearFootprint(F, x, y, r) {
    var P = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
    for (var i = 0; i < F.tris.length; i++) {
      var b = F.boxes[i];
      if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      if (!separated(F.tris[i], P, 0)) return true;
    }
    return false;
  }

  /**
   * The contacts between the shells of a buildSolid result: every pair that
   * genuinely meets, as { a, b, kind: 'side' | 'stack', upper }, after the
   * plane snap. Returns { feet, edges, snapped: [{shell, from, to}] }; each
   * foot carries `from` (its bottom as swept) and `rest` (the top plane it
   * sits on, if any).
   */
  function shellContacts(built) {
    var n = built.shells.length, feet = [], i;
    for (i = 0; i < n; i++) {
      var sh = built.shells[i];
      feet.push(shellFootprint(built.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9)));
    }
    // The plane snap: a bottom within PLANE_SNAP_MM of some other top, but not on it.
    var tops = feet.map(function (f) { return f.top; }).sort(function (x, y) { return x - y; });
    var snapped = [];
    feet.forEach(function (f, k) {
      var lo = 0, hi = tops.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (tops[mid] < f.bot) lo = mid + 1; else hi = mid; }
      var best = null;
      for (var q = Math.max(0, lo - 1); q <= Math.min(tops.length - 1, lo + 1); q++) {
        var d = Math.abs(tops[q] - f.bot);
        if (d <= PLANE_SNAP_MM && (best == null || d < Math.abs(best - f.bot))) best = tops[q];
      }
      f.from = f.bot;
      if (best != null) { f.rest = best; if (best !== f.bot) snapped.push({ shell: k, from: f.bot, to: best }); f.bot = best; }
    });

    // Candidate pairs by XY box on a uniform grid, then the real test.
    var cell = 0;
    feet.forEach(function (f) { if (f.tris.length) cell = Math.max(cell, Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1])); });
    cell = Math.max(cell, 1);
    var grid = new Map(), edges = [];
    for (i = 0; i < n; i++) {
      var F = feet[i];
      if (!F.tris.length) continue;
      var x0 = Math.floor((F.box[0] - CONTACT_MM) / cell), x1 = Math.floor((F.box[2] + CONTACT_MM) / cell);
      var y0 = Math.floor((F.box[1] - CONTACT_MM) / cell), y1 = Math.floor((F.box[3] + CONTACT_MM) / cell);
      var seen = {};
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
        var key = x + ',' + y, list = grid.get(key);
        if (!list) { grid.set(key, list = []); }
        for (var t = 0; t < list.length; t++) {
          var j = list[t];
          if (seen[j]) continue;
          seen[j] = 1;
          var G2 = feet[j];
          if (F.box[2] + CONTACT_MM < G2.box[0] || G2.box[2] + CONTACT_MM < F.box[0] ||
              F.box[3] + CONTACT_MM < G2.box[1] || G2.box[3] + CONTACT_MM < F.box[1]) continue;
          var zo = Math.min(F.top, G2.top) - Math.max(F.bot, G2.bot);
          var kind = null;
          if (zo > CONTACT_MM) { if (footprintsMeet(F, G2, CONTACT_MM)) kind = 'side'; }
          else if (zo === 0) { if (footprintsMeet(F, G2, -CONTACT_MM)) kind = 'stack'; }
          // For a stack, `upper` is the shell resting on the other's top.
          if (kind) edges.push({ a: j, b: i, kind: kind, upper: kind === 'stack' ? (F.bot === G2.top ? i : j) : -1 });
        }
        list.push(i);
      }
    }
    return { feet: feet, edges: edges, snapped: snapped };
  }

  /** A shell's triangles with its bottom plane moved from `from` to `to`, on a copy. */
  function snapBottom(t, from, to) {
    var out = new Float32Array(t);
    for (var k = 2; k < out.length; k += 3) if (out[k] === from) out[k] = to;
    return out;
  }

  function defectsLib() {
    var D = root && root.NSO_Defects;
    if (!D && typeof require === 'function') {
      // Under node: both are classic scripts that hang themselves off
      // `window`, NSO_Repair first - loaded the way their own test loads them.
      try {
        var vm = require('vm'), fs = require('fs'), path = require('path');
        var W = { Math: Math, Object: Object, Array: Array, Float32Array: Float32Array, Float64Array: Float64Array,
                  Int32Array: Int32Array, Uint32Array: Uint32Array, Map: Map, Set: Set, JSON: JSON, Error: Error,
                  Number: Number, String: String, Infinity: Infinity, NaN: NaN, isFinite: isFinite, console: console };
        W.window = W;
        vm.createContext(W);
        ['NSO_Repair.js', 'nso-defects.js'].forEach(function (f) {
          vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), W, { filename: f });
        });
        D = W.NSO_Defects;
      } catch (e) { D = null; }
    }
    return D && typeof D.locate === 'function' ? D : null;
  }

  /**
   * The canonical checker's verdict on one soup, WITH where it fails:
   * NSO_Defects.locate, the browser copy of tools/mesh_validate.py's battery
   * (same 1e-4 weld, same edge counts, same self-intersection pairs, same
   * degenerate test - held to it by tools/nso_defect_overlay_test.js), with
   * the wall pass off as the validator's default has it. Returns { ok, why,
   * points } - `points` the flat xyz of every defect it marks (the ends of
   * every open or non-manifold edge, the corners of every piercing triangle,
   * the centre of every degenerate one).
   */
  function checkSolid(D, soup) {
    var r = D.locate(soup, { minWall: 0 });
    var pts = [];
    function add(arr) { for (var i = 0; i < arr.length; i++) pts.push(arr[i]); }
    add(r.marks.openEdges); add(r.marks.nonManifoldEdges); add(r.marks.pierceTris);
    if (r.degenerateTris) {
      for (var o = 0; o < soup.length; o += 9) {
        var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
        var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
        var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        if (0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) < 1e-12) {
          pts.push((soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
                   (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3);
        }
      }
    }
    var bad = r.fails.slice();
    var v = signedVolume(soup, 0, soup.length);
    if (!(v > 0)) bad.push('volume ' + v);
    return { ok: !bad.length, why: bad.join(', '), points: pts };
  }

  /* How a group is unioned, tried in this order until one gives a single body
     the checker passes. Each is the kernel on the same shells and the same
     contacts; they differ only in what is known to trip it (measured, see the
     header and docs/GCODE-MICROSCOPE.md "Fused selections"):

       exact     stacked beads snapped onto the plane they rest on, one float32
                 write per group, the tree's cleanup once. Exact volume.
       seated    stacked beads seated BOND_MM into the one below, so no contact
                 is coplanar. Fixes a strip the kernel leaves uncut where a
                 bead crosses the one it rests on. Adds <= BOND_MM x area.
       stepwise  exact, but every union written to float32 and cleaned before
                 it is used again - the tree's per-fold cleanup applied per
                 step. Fixes the vertex pairs one float32 step apart that a
                 hairpin repeated up a wall leaves in one big body. */
  var LADDER = [
    { name: 'exact', seat: 0, stepwise: false },
    { name: 'seated', seat: BOND_MM, stepwise: false },
    { name: 'stepwise', seat: 0, stepwise: true }
  ];

  /**
   * One solid per group of runs that genuinely touch, from a buildSolid result.
   *
   * Shells that touch nothing are passed through untouched. Each connected
   * group of touching shells is unioned by the app's kernel (NSO_CSG, the
   * adapter NSO_unionSoups is built on), pair by pair and only ever across a
   * real contact: every round pairs each body with its smallest untaken
   * neighbour, so a stack of N layers takes log2(N) rounds of balanced unions
   * rather than an N-long fold. The group's one body is written to float32
   * and finished by the tree's own cleanup for that write
   * (NSO_SupportTree._finishUnion, gated there on census and volume), then
   * held to the canonical checker. A group is fused only if it comes out as
   * ONE body that passes; otherwise the next way in LADDER is tried, and a
   * group no way fuses soundly is left as its shells, as swept, and named -
   * never exported as a defective solid.
   *
   * WHY NSO_CSG AND NOT NSO_unionSoups PER STEP (measured, tabletop Outer +
   * Inner wall, 1,396 shells): NSO_unionSoups writes every result as float32,
   * and a body here goes back into the kernel dozens of times; the round trip
   * alone put 132 non-manifold edges and 845 piercing pairs into the export.
   * Kept in the kernel, the body is written once - the tree's own pattern:
   * union, one write, one cleanup.
   *
   * @param {object} built   buildSolid's result
   * @param {object} [opts]  { csg, finishUnion, defects } - defaults are the
   *                         app's NSO_CSG, NSO_SupportTree._finishUnion and
   *                         NSO_Defects; { ladder } to restrict the ways tried;
   *                         { maxShells, maxJunctions } - past either it refuses
   *                         (ok: false, reason) rather than hold the page
   * @returns {Promise<{ok, positions, bodies, stats, contacts, reason}>}
   */
  function fuseShells(built, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var CSG = opts.csg || (root && root.NSO_CSG) || (typeof NSO_CSG !== 'undefined' ? NSO_CSG : null);
    var finish = opts.finishUnion === false ? null : (opts.finishUnion || treeFinish());
    var D = opts.defects || defectsLib();
    var ladder = opts.ladder ? LADDER.filter(function (w) { return opts.ladder.indexOf(w.name) >= 0; }) : LADDER;
    var n = built.shells.length;
    function soupOf(i) {
      var sh = built.shells[i];
      return built.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9);
    }
    // The union runs on the page's own thread. Past these it would hold the
    // tab for minutes (measured ~1.4 ms a junction; tabletop whole is 24,960
    // shells and 167,293 junctions, ~4 min), so it is refused, by name, and
    // the caller exports the shells as swept.
    var maxShells = opts.maxShells == null ? MAX_SHELLS : opts.maxShells;
    var maxJunctions = opts.maxJunctions == null ? MAX_JUNCTIONS : opts.maxJunctions;
    if (n > maxShells) {
      return Promise.resolve({ ok: false, stats: null, reason: n + ' runs is over the ' + maxShells +
        ' G-scope fuses in one go - select fewer layers or features to fuse them' });
    }
    var ct = shellContacts(built);
    if (ct.edges.length > maxJunctions) {
      return Promise.resolve({ ok: false, stats: null, reason: ct.edges.length + ' junctions is over the ' + maxJunctions +
        ' G-scope fuses in one go - select fewer layers or features to fuse them' });
    }
    var stats = {
      shells: n, contacts: ct.edges.length,
      side: ct.edges.filter(function (e) { return e.kind === 'side'; }).length,
      stack: ct.edges.filter(function (e) { return e.kind === 'stack'; }).length,
      groups: 0, fusedGroups: 0, untouched: 0, bodies: 0, unions: 0,
      ways: {}, splits: [], setAside: 0, seams: 0,
      snappedShells: ct.snapped.length, snapMaxMm: 0, seatedShells: 0, seatBoundMm3: 0,
      slivers: 0, sliverMm3: 0, cavities: 0, finishDropped: 0, finishWelded: 0, finishRefused: [],
      shellsVolume: 0, fusedVolume: 0, overlapRemovedMm3: 0, ms: 0
    };
    ct.snapped.forEach(function (sn) { stats.snapMaxMm = Math.max(stats.snapMaxMm, Math.abs(sn.to - sn.from)); });

    // Connected groups of the contact graph.
    var parent = [];
    for (var i = 0; i < n; i++) parent.push(i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    ct.edges.forEach(function (e) { var ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb; });
    var groupOf = new Map();
    for (i = 0; i < n; i++) {
      var r = find(i);
      if (!groupOf.has(r)) groupOf.set(r, []);
      groupOf.get(r).push(i);
    }
    var groups = [], singles = [];
    groupOf.forEach(function (members) { (members.length > 1 ? groups : singles).push(members); });
    stats.groups = groups.length;
    stats.untouched = singles.length;
    for (i = 0; i < n; i++) stats.shellsVolume += built.shells[i].volume;

    var bodies = [];     // { soup, shells: [], fused }
    singles.forEach(function (m) { bodies.push({ soup: soupOf(m[0]), shells: m, fused: false }); });

    function done() {
      var total = 0;
      bodies.forEach(function (b) { total += b.soup.length; });
      var positions = new Float32Array(total), o = 0, out = [];
      bodies.forEach(function (b) {
        positions.set(b.soup, o);
        var vol = signedVolume(b.soup, 0, b.soup.length);
        stats.fusedVolume += vol;
        out.push({ triStart: o / 9, triCount: b.soup.length / 9, shells: b.shells, fused: b.fused,
                   way: b.way || null, volume: vol });
        o += b.soup.length;
      });
      stats.bodies = out.length;
      stats.overlapRemovedMm3 = stats.shellsVolume - stats.fusedVolume;
      stats.ms = Date.now() - t0;
      return { ok: true, positions: positions, bodies: out, stats: stats, contacts: ct.edges,
               reason: describeFuse(stats) };
    }
    if (!groups.length) return Promise.resolve(done());
    if (!CSG || typeof CSG.load !== 'function') {
      return Promise.resolve({ ok: false, stats: stats,
        reason: 'app-join.js is not loaded - NSO_CSG is the app\'s one boolean kernel and nothing here reimplements it' });
    }
    if (!D) {
      return Promise.resolve({ ok: false, stats: stats,
        reason: 'nso-defects.js is not loaded - a fused body is not exported without the canonical checker\'s verdict' });
    }

    // Stacked contacts: which shell rests on which plane.
    var restOn = new Map();
    ct.edges.forEach(function (e) { if (e.kind === 'stack') restOn.set(e.upper, ct.feet[e.upper]); });

    /* One way of unioning one group. Returns { soup, parts, unions, slivers,
       sliverMm3, seated, seatBound, finish } or { fail }. */
    function unionGroup(wasm, members, way) {
      var body = new Map(), adj = new Map(), next = 0, owner = new Map();
      var res = { unions: 0, slivers: 0, sliverMm3: 0, seated: 0, seatBound: 0, cavities: 0,
                  finishDropped: 0, finishWelded: 0, finishRefused: [] };
      function release() { body.forEach(function (b) { b.man.delete(); }); body.clear(); }
      function cleaned(man) {
        var soup = CSG.manifoldToSoup(man);
        if (!finish) return soup;
        var f = finish(soup);
        res.finishDropped += f.dropped || 0;
        res.finishWelded += f.welded || 0;
        if (f.refused) res.finishRefused.push(f.refused);
        return f.soup;
      }
      for (var k = 0; k < members.length; k++) {
        var s = members[k], t = soupOf(s), f = restOn.get(s);
        if (f) {
          // Onto the plane it rests on (exact), or BOND_MM into it (seated).
          var to = Math.fround(f.rest - way.seat);
          if (to !== f.from) t = snapBottom(t, f.from, to);
          if (way.seat) { res.seated++; res.seatBound += way.seat * f.area; }
        }
        var man = null;
        try { man = CSG.soupToManifold(wasm, t); } catch (e) { man = null; }
        if (!man || man.status() !== 'NoError') {
          if (man) man.delete();
          release();
          return { fail: 'the kernel would not read shell ' + s + ' (' + (man ? man.status() : 'threw') + ')' };
        }
        body.set(next, { man: man, parts: 1, shells: [s], tris: t.length / 9 });
        adj.set(next, new Set());
        owner.set(s, next);
        next++;
      }
      ct.edges.forEach(function (e) {
        if (!owner.has(e.a) || !owner.has(e.b)) return;
        var a = owner.get(e.a), b = owner.get(e.b);
        adj.get(a).add(b); adj.get(b).add(a);
      });

      for (;;) {
        var ids = Array.from(body.keys()).filter(function (id) { return adj.get(id).size; });
        if (!ids.length) break;
        ids.sort(function (x, y) { return body.get(x).tris - body.get(y).tris; });
        var taken = new Set(), pairs = [];
        ids.forEach(function (g) {
          if (taken.has(g)) return;
          var best = -1;
          adj.get(g).forEach(function (h) {
            if (taken.has(h)) return;
            if (best < 0 || body.get(h).tris < body.get(best).tris) best = h;
          });
          if (best < 0) return;
          taken.add(g); taken.add(best);
          pairs.push([g, best]);
        });
        for (var q = 0; q < pairs.length; q++) {
          var pr = pairs[q], A = body.get(pr[0]), B = body.get(pr[1]);
          var u = null, parts = 0, why = '';
          try {
            u = A.man.add(B.man);
            if (u.status() !== 'NoError') why = 'the kernel rejected a union: ' + u.status();
            else {
              // What came out, by volume. A component with none is the
              // kernel's, not the beads': a flat sliver left where coincident
              // coplanar faces meet - dropped and counted. A NEGATIVE one is
              // a cavity: air the beads enclose (walls round a pocket of
              // sparse infill, closed over by the layer above) - part of its
              // body, never a part of its own. Only positive ones are parts.
              var bits = u.decompose(), keep = [], dropped = 0;
              bits.forEach(function (x) {
                var v = x.volume();
                if (v > SLIVER_MM3) parts++;
                if (Math.abs(v) > SLIVER_MM3) keep.push(x);
                else { dropped++; res.slivers++; res.sliverMm3 += Math.abs(v); x.delete(); }
              });
              if (dropped) {
                // Rebuilt from the kept components' own meshes, side by side.
                // Not Manifold.compose: in this binding that is a union, and a
                // union of a body with its cavity fills the cavity in.
                var total = 0, soups = keep.map(function (x) { var t = CSG.manifoldToSoup(x); total += t.length; return t; });
                var all = new Float32Array(total), o = 0;
                soups.forEach(function (t) { all.set(t, o); o += t.length; });
                u.delete();
                u = CSG.soupToManifold(wasm, finish ? finish(all).soup : all);
                if (u.status() !== 'NoError') why = 'the body without its slivers would not re-read: ' + u.status();
              }
              keep.forEach(function (x) { x.delete(); });
              if (!why && !(parts < A.parts + B.parts)) {
                why = 'a contact the kernel would not merge (' + A.parts + ' + ' + B.parts + ' part(s) in, ' + parts + ' out)';
              }
            }
          } catch (e) { why = 'the kernel threw: ' + ((e && e.message) || e); }
          if (why) {
            if (u) u.delete();
            release();
            return { fail: why };
          }
          res.unions++;
          if (way.stepwise) {
            var u2 = CSG.soupToManifold(wasm, cleaned(u));
            u.delete();
            u = u2;
          }
          var id = next++;
          var nb = new Set();
          adj.get(pr[0]).forEach(function (x) { nb.add(x); });
          adj.get(pr[1]).forEach(function (x) { nb.add(x); });
          nb.delete(pr[0]); nb.delete(pr[1]);
          [pr[0], pr[1]].forEach(function (old) {
            adj.get(old).forEach(function (x) { if (adj.has(x)) adj.get(x).delete(old); });
            adj.delete(old);
            body.get(old).man.delete();
            body.delete(old);
          });
          nb.forEach(function (x) { adj.get(x).add(id); });
          adj.set(id, nb);
          body.set(id, { man: u, parts: parts, shells: A.shells.concat(B.shells), tris: A.tris + B.tris });
        }
      }
      if (body.size !== 1) {
        // Cannot happen for a connected group whose every union merged; say so if it does.
        release();
        return { fail: 'the group came out as ' + body.size + ' bodies' };
      }
      var only = body.values().next().value;
      only.man.decompose().forEach(function (x) { if (x.volume() < -SLIVER_MM3) res.cavities++; x.delete(); });
      res.soup = cleaned(only.man);
      release();
      return res;
    }

    /* Fuse one connected set of shells: the ladder, and if no way gives a
       sound single body, set aside only the shells AT the defects the checker
       located and fuse the rest - so a spot the kernel cannot write soundly
       costs the junctions of the few beads that meet there, left as faces in
       contact as every junction was before this, and not the whole group.
       Where there is nothing to locate (a union refused outright) the set is
       split at its median Z instead. Every set-aside bead leaves as swept. */
    function fuseSet(wasm, members, depth) {
      var tried = [], best = null;
      for (var w = 0; w < ladder.length; w++) {
        var way = ladder[w];
        var res = unionGroup(wasm, members, way);
        var why = res.fail || null, chk = null;
        if (!why) {
          chk = checkSolid(D, res.soup);
          if (!chk.ok) why = 'the checker fails the fused body: ' + chk.why;
        }
        if (why) {
          tried.push(way.name + ': ' + why);
          if (chk && chk.points.length && (!best || chk.points.length < best.points.length)) best = chk;
          continue;
        }
        stats.fusedGroups++;
        stats.ways[way.name] = (stats.ways[way.name] || 0) + 1;
        stats.unions += res.unions;
        stats.slivers += res.slivers; stats.sliverMm3 += res.sliverMm3; stats.cavities += res.cavities;
        stats.seatedShells += res.seated; stats.seatBoundMm3 += res.seatBound;
        stats.finishDropped += res.finishDropped; stats.finishWelded += res.finishWelded;
        res.finishRefused.forEach(function (x) { stats.finishRefused.push(x); });
        bodies.push({ soup: res.soup, shells: members.slice().sort(function (x, y) { return x - y; }),
                      fused: true, way: way.name });
        return;
      }
      var blamed = best ? shellsAt(members, best.points) : [];
      var entry = { shells: members.length, depth: depth, tried: tried, setAside: blamed.slice() };
      stats.splits.push(entry);
      if (blamed.length && blamed.length < members.length && depth < MAX_DEPTH) {
        var out = new Set(blamed);
        blamed.forEach(function (x) { bodies.push({ soup: soupOf(x), shells: [x], fused: false }); });
        stats.setAside += blamed.length;
        componentsOf(members.filter(function (x) { return !out.has(x); })).forEach(function (part) {
          if (part.length === 1) bodies.push({ soup: soupOf(part[0]), shells: part, fused: false });
          else fuseSet(wasm, part, depth + 1);
        });
        return;
      }
      if (members.length < 2 || depth >= MAX_DEPTH) {
        members.forEach(function (x) { bodies.push({ soup: soupOf(x), shells: [x], fused: false }); });
        stats.setAside += members.length;
        return;
      }
      // Nothing located: split at the median bottom Z (a single layer by position in it).
      entry.splitZ = true;
      var byZ = members.slice().sort(function (x, y) {
        return (ct.feet[x].bot - ct.feet[y].bot) || (x - y);
      });
      var zMid = ct.feet[byZ[byZ.length >> 1]].bot;
      var lower = byZ.filter(function (x) { return ct.feet[x].bot < zMid; });
      if (!lower.length) lower = byZ.slice(0, byZ.length >> 1);
      var inLower = new Set(lower);
      var upper = byZ.filter(function (x) { return !inLower.has(x); });
      [lower, upper].forEach(function (half) {
        componentsOf(half).forEach(function (part) {
          if (part.length === 1) bodies.push({ soup: soupOf(part[0]), shells: part, fused: false });
          else fuseSet(wasm, part, depth + 1);
        });
      });
    }

    /** The members whose bead is within a bead's reach of any defect point. */
    function shellsAt(members, pts) {
      var hit = [];
      members.forEach(function (x) {
        var f = ct.feet[x], r = BLAME_MM;
        for (var k = 0; k < pts.length; k += 3) {
          if (pts[k] >= f.box[0] - r && pts[k] <= f.box[2] + r && pts[k + 1] >= f.box[1] - r && pts[k + 1] <= f.box[3] + r &&
              pts[k + 2] >= Math.min(f.bot, f.from) - r && pts[k + 2] <= f.top + r && nearFootprint(f, pts[k], pts[k + 1], r)) {
            hit.push(x);
            return;
          }
        }
      });
      return hit;
    }

    /** Connected parts of a set of shells, over the contacts inside it. */
    function componentsOf(set) {
      var inSet = new Set(set), par = new Map();
      set.forEach(function (x) { par.set(x, x); });
      function f(x) { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; }
      ct.edges.forEach(function (e) {
        if (!inSet.has(e.a) || !inSet.has(e.b)) return;
        var ra = f(e.a), rb = f(e.b);
        if (ra !== rb) par.set(ra, rb);
      });
      var out = new Map();
      set.forEach(function (x) { var r = f(x); if (!out.has(r)) out.set(r, []); out.get(r).push(x); });
      return Array.from(out.values());
    }

    return Promise.resolve(CSG.load()).then(function (wasm) {
      groups.forEach(function (members) { fuseSet(wasm, members, 0); });
      // Junctions that ended up between two different bodies: still faces in contact.
      var bodyOf = new Map();
      bodies.forEach(function (b, k) { b.shells.forEach(function (sh) { bodyOf.set(sh, k); }); });
      ct.edges.forEach(function (e) { if (bodyOf.get(e.a) !== bodyOf.get(e.b)) stats.seams++; });
      return done();
    }, function (err) {
      return { ok: false, stats: stats, reason: 'the CSG kernel failed to load: ' + ((err && err.message) || err) };
    });
  }

  function describeFuse(st) {
    var bits = [st.shells + ' run shell' + (st.shells === 1 ? '' : 's') + ' -> ' + st.bodies + ' solid' +
                (st.bodies === 1 ? '' : 's')];
    if (st.unions) bits.push(st.unions + ' union' + (st.unions === 1 ? '' : 's') + ' at ' +
                             (st.contacts - st.seams) + ' of ' + st.contacts + ' junction' +
                             (st.contacts === 1 ? '' : 's') + ' (' + st.stack + ' stacked, ' + st.side + ' side by side)');
    if (st.untouched && st.unions) bits.push(st.untouched + ' touching nothing, left as swept');
    if (st.overlapRemovedMm3 > 1e-9) bits.push((Math.round(st.overlapRemovedMm3 * 1000) / 1000).toFixed(3) +
                                               ' mm\u00b3 of overlap counted once');
    if (st.seams) bits.push(st.seams + ' junction' + (st.seams === 1 ? '' : 's') + ' left as faces in contact' +
                            (st.setAside ? ' (' + st.setAside + ' bead' + (st.setAside === 1 ? '' : 's') +
                             ' set aside where the kernel gave no sound solid)' : ' - the kernel gave no sound solid across ' +
                             (st.seams === 1 ? 'it' : 'them')));
    if (st.cavities) bits.push(st.cavities + ' enclosed air pocket' + (st.cavities === 1 ? '' : 's') + ' kept');
    return bits.join(', ');
  }

  return {
    chainsOf: chainsOf,
    sweepChain: sweepChain,
    buildSolid: buildSolid,
    shellContacts: shellContacts,
    fuseShells: fuseShells,
    describeFuse: describeFuse,
    PLANE_SNAP_MM: PLANE_SNAP_MM,
    BOND_MM: BOND_MM,
    MAX_SHELLS: MAX_SHELLS,
    MAX_JUNCTIONS: MAX_JUNCTIONS,
    LADDER: LADDER.map(function (w) { return w.name; }),
    checkSolid: function (soup) { var D = defectsLib(); return D ? checkSolid(D, soup) : null; },
    firstOverlap: firstOverlap,
    shellOfTriangle: shellOfTriangle,
    signedVolume: signedVolume
  };

  /*
   * PAINT SCOPE: NONE (generator, not a bake). It reads parsed G-code moves
   * and returns a new soup; it never reads or writes a placed model. The
   * G-scope export that puts the result on the plate ADDS a piece and edits
   * none, the same category as Stock create.
   *
   * NON-SOLID SCOPE: not a consumer. Every shell it emits is closed.
   */
});
