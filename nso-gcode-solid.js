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
 * There is no union anywhere, and nothing to heal afterwards.
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
 * NOT A UNION. The chains of a selection are separate closed shells. Beads
 * that touch (one layer on the next) or overlap (neighbouring perimeters the
 * slicer spaced closer than their width) still do; this file makes every
 * bead a sound solid and does not merge beads into each other.
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

  return {
    chainsOf: chainsOf,
    sweepChain: sweepChain,
    buildSolid: buildSolid,
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
