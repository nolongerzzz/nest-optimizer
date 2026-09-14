/* ============================================================
   NSO inside corners — the corners8 setback, taken into a pocket
   no ES modules, browser-global like the rest of the app

   What this is for
   ----------------
   corners8 (`rawVertexBallCorners`, app-finish.js) rounds the four
   vertices and four perimeter edges of ONE clicked face with the
   setback blend: the blend tapers to nothing at the face and again
   at depth R, so nothing stands proud and there is no shelf stub.
   It is an outer-hull recipe. This module gives a pocket's interior
   the same treatment.

   Why there is no concave version of the setback maths in here
   ------------------------------------------------------------
   Because there does not need to be, and writing one would be wrong.
   Measured, not assumed (numbers in docs/INSIDE-CORNERS.md):

   - `rawVertexBallCorners` is subtractive by construction. It clips
     the cap face and both walls back and stitches the blend into the
     volume it removed; nothing in it can emit surface OUTSIDE the
     original faces. Rounding a CONCAVE corner adds material. So the
     operation is not a sign flip, it is the other direction entirely.
   - It also refuses concavity outright, at the first gate:
     `if (turn[ai] * wind <= 0) { skipped++; continue; }` drops any
     corner whose turn opposes the loop winding, and the all-or-nothing
     rule below it then throws for the whole face.
   - And its blend is a TWO-edge construction. `b.tip3 = b.at(0,0,R)`
     is "the knife end": the blend runs down to a point on the depth
     edge where the two walls meet, and that edge is left sharp. A
     corner with three rounded edges has no such point to close on.

   So the pocket is reached the way the shipped inside1..inside3 path
   already reaches it: run the UNMODIFIED convex engine on the plug —
   the box that was cut out — and let the boolean mirror it inward.
   The engine only ever sees the convex body it was written for.

   Relationship to the shipped pocket wrap
   ---------------------------------------
   This does not replace or compete with `wrapPocketsInPlace` /
   `nsoWrapBrick`. Those regenerate both boxes through `rawWrapSolid`,
   which rounds ALL twelve edges of the pocket ('fillet') or its eight
   vertices with the mid-edges square ('corners'). This is the third
   shape: the floor's four vertices and four floor edges carry the
   setback, and the four vertical wall edges stay square — which is
   what corners8 does on the outside and what neither wrap mode can
   express. The paint / skip-list logic (mask6, inside3) is untouched:
   this reads a pocket box and hands back a soup.

   The lid rim stays sharp for the same reason it does in the shipped
   path, and by the same mechanism: the plug is pushed 2R+1 past its
   own mouth, so the treated end is the pocket FLOOR and the mouth end
   of the plug sits outside the hull entirely. The rim goes on being
   the edge the hull face makes with the wall. Nothing here reaches
   into that rule.
   ============================================================ */

/* Soup convention, same as the rest of NSO: a flat array of floats,
   9 per triangle (3 verts x xyz), no index buffer. */

/* How far past its own mouth the plug is pushed, in units of R. Same
   figure the shipped wrap uses (`over = 2 * R + 1`), for the same
   reason: whatever the treatment does to that end has to land clear
   of the hull face, or it would round the rim. */
function NSO_insideOverreach(R) { return 2 * R + 1; }

/* Triangle count of a soup. */
function NSO_insideTriCount(soup) { return (soup && soup.length ? (soup.length / 9) | 0 : 0); }

/* Enclosed signed volume. Positive for an outward-wound closed solid. */
function NSO_insideVolume(soup) {
  var n = NSO_insideTriCount(soup), v = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    v += soup[o]     * (soup[o + 4] * soup[o + 8] - soup[o + 5] * soup[o + 7])
       - soup[o + 1] * (soup[o + 3] * soup[o + 8] - soup[o + 5] * soup[o + 6])
       + soup[o + 2] * (soup[o + 3] * soup[o + 7] - soup[o + 4] * soup[o + 6]);
  }
  return v / 6;
}

/* Edge health, counted on DIRECTED edges.

   `nsoSealScore` (app-finish.js) welds by coordinate rounding and counts
   undirected edges, so a backwards-wound face pairs every edge and reads
   0 open / 0 non-manifold while the surface is inside out. That is the
   hole HANDOFF.md records against `NSO_edgeStats` and
   `rawCheckWatertightQuick`, and it is not theoretical here: the
   corners-only engine's plug bake scores 0/0 on it and is still refused
   by the kernel as "Not manifold" — it carries 72 inconsistently wound
   triangles. Counting directed edges sees that: on a consistently wound
   closed surface every directed edge appears exactly once, and its
   reverse exactly once.

   Returns { open, nm, stacked }: `stacked` is the count of directed
   edges used more than once, which is the backwards-wound signature. */
function NSO_insideEdgeScore(soup) {
  var q = 1e4;
  var vk = function (i) {
    return Math.round(soup[i] * q) + '|' + Math.round(soup[i + 1] * q) + '|' + Math.round(soup[i + 2] * q);
  };
  var dir = new Map(), und = new Map();
  for (var t = 0; t + 8 < soup.length; t += 9) {
    var K = [vk(t), vk(t + 3), vk(t + 6)];
    for (var e = 0; e < 3; e++) {
      var a = K[e], b = K[(e + 1) % 3];
      if (a === b) continue;                       /* slivers carry no edge */
      dir.set(a + '>' + b, (dir.get(a + '>' + b) || 0) + 1);
      var u = a < b ? a + '~' + b : b + '~' + a;
      und.set(u, (und.get(u) || 0) + 1);
    }
  }
  var open = 0, nm = 0, stacked = 0;
  und.forEach(function (c) { if (c % 2) open++; if (c > 2) nm++; });
  dir.forEach(function (c) { if (c > 1) stacked += c - 1; });
  return { open: open, nm: nm, stacked: stacked };
}

/* Normalise the two pocket shapes the app already produces into one.

   `rawBoxPockets` hands back { lo, hi, openAxis, openSide, faces } and
   `rawPocketBrick` hands back { plo, phi, mouthAxis, mouthSide }. Both
   describe the same thing. Anything else is refused rather than guessed
   at, so a caller cannot quietly pass a shape this was not written for. */
function NSO_insidePocketBox(p) {
  if (!p) return null;
  if (p.lo && p.hi && p.openAxis != null)
    return { lo: p.lo.slice(), hi: p.hi.slice(), axis: p.openAxis | 0, side: p.openSide ? 1 : 0 };
  if (p.plo && p.phi && p.mouthAxis != null)
    return { lo: p.plo.slice(), hi: p.phi.slice(), axis: p.mouthAxis | 0, side: p.mouthSide ? 1 : 0 };
  return null;
}

/* The radius this pocket can actually take, and why it was clamped.

   The setback engine does its own clamping per corner (`wallLimitAt`,
   and the tightest corner sets one radius for the whole face). This is
   the coarser gate in front of it, on the same rule `rawWrapSolid` uses
   for a box: no more than 0.45 of the smallest span the treatment has to
   fit inside. For a pocket the relevant spans are its two CROSS-SECTION
   sides — the depth is not a limit, because the setback only reaches R
   down from the floor and the mouth end is not treated at all. */
function NSO_insideClampR(box, R) {
  var o = [0, 1, 2].filter(function (k) { return k !== box.axis; });
  var span = Math.min(box.hi[o[0]] - box.lo[o[0]], box.hi[o[1]] - box.lo[o[1]]);
  var lim = 0.45 * span;
  return { R: Math.min(R, lim), limit: lim, span: span, clamped: R > lim };
}

/* Build the plug: the pocket box, pushed past its own mouth, with the
   corners8 setback baked into the end that becomes the pocket FLOOR.

   `engine` is `rawVertexBallCorners`; `boxSoup` is `rawBoxSoup`. They are
   passed in rather than read off the global so the regression suite can
   run the real engines headlessly, and so this file states its whole
   dependency surface instead of hiding it.

   Sync, and it throws with the engine's own reason. Nothing is committed
   anywhere by this call. */
function NSO_insidePlanPlug(box, R, engine, boxSoup) {
  var lo = box.lo.slice(), hi = box.hi.slice();
  var over = NSO_insideOverreach(R);
  if (box.side) hi[box.axis] += over; else lo[box.axis] -= over;

  /* The pocket floor is the plug end that is still inside the hull:
     a pocket opening the +side has its floor at the plug's MIN face on
     that axis, and vice versa. keepMin=true is the engine's convention
     for softening the MIN face and keeping the rest of the body. */
  var floorKeepMin = !!box.side;
  var plug = engine(boxSoup(lo, hi), box.axis, floorKeepMin, R, { minTurnDeg: 25 });
  var score = NSO_insideEdgeScore(plug);
  return { plug: plug, lo: lo, hi: hi, floorKeepMin: floorKeepMin, over: over, score: score };
}

/* The bake.

   `ops` supplies the two kernel calls the app already carries:
   { union, subtract }, each (a, b) -> Promise<{ ok, soup, reason }>.
   In the app those are `nsoUnionSoups` and `nsoSubtractSoups`.
   `deps` supplies { engine, boxSoup } as above.

   Fail-safe contract, same as every other bake in this app: any refusal
   returns { ok:false, reason } and the caller's soup is untouched. */
function NSO_insideCornersBake(soup, pocket, R, deps, ops) {
  var box = NSO_insidePocketBox(pocket);
  if (!box) return Promise.resolve({ ok: false, reason: 'not a pocket box this module can read' });
  if (!deps || typeof deps.engine !== 'function' || typeof deps.boxSoup !== 'function')
    return Promise.resolve({ ok: false, reason: 'no setback engine handed in' });
  if (!ops || typeof ops.union !== 'function' || typeof ops.subtract !== 'function')
    return Promise.resolve({ ok: false, reason: 'no CSG kernel handed in' });

  var clamp = NSO_insideClampR(box, R);
  if (!(clamp.R > 1e-3))
    return Promise.resolve({ ok: false, reason: 'R=' + R + ' leaves nothing to round in a pocket ' +
                                                clamp.span.toFixed(2) + 'mm across' });

  var planned;
  try { planned = NSO_insidePlanPlug(box, clamp.R, deps.engine, deps.boxSoup); }
  catch (err) { return Promise.resolve({ ok: false, reason: 'setback refused the plug: ' +
                                                  (err && err.message ? err.message : err) }); }

  /* Gate the plug BEFORE the kernel sees it. A bake that is 0 open and 0
     non-manifold can still be inside out, and the kernel's answer for that
     is a bare "Not manifold" with nothing to act on. Say which it is. */
  var ps = planned.score;
  if (ps.open || ps.nm || ps.stacked)
    return Promise.resolve({ ok: false, reason: 'the plug bake is not a closed solid (open ' + ps.open +
                                                ', non-manifold ' + ps.nm + ', backwards-wound ' + ps.stacked +
                                                ') - piece unchanged' });

  var before = NSO_insideEdgeScore(soup);
  var volBefore = NSO_insideVolume(soup);

  /* The pocket is already cut, so a rounded tool dropped into it touches
     nothing - it is strictly inside the hole that is there. Fill the pocket
     back flush first, then cut it again with the rounded plug. The fill is
     the pocket's own box, so it can only ever put back what that pocket took
     out and cannot reach the rest of the piece. Same two-step, and the same
     reasoning, as wrapPocketsInPlace. */
  return ops.union(soup, deps.boxSoup(box.lo, box.hi)).then(function (filled) {
    if (!filled.ok) return { ok: false, reason: 'fill failed: ' + filled.reason };
    return ops.subtract(filled.soup, planned.plug).then(function (cut) {
      if (!cut.ok) return { ok: false, reason: 'cut failed: ' + cut.reason };
      var after = NSO_insideEdgeScore(cut.soup);
      if (after.open > before.open || after.nm > before.nm || after.stacked > before.stacked)
        return { ok: false, reason: 'the cut did not close (open ' + before.open + '→' + after.open +
                                    ', non-manifold ' + before.nm + '→' + after.nm +
                                    ', backwards-wound ' + before.stacked + '→' + after.stacked +
                                    ') - piece unchanged' };
      /* Rounding a concave corner ADDS material. A bake that took material
         away has mirrored the wrong way round and must not ship. */
      var volAfter = NSO_insideVolume(cut.soup);
      if (volAfter < volBefore - 1e-6)
        return { ok: false, reason: 'the bake removed ' + (volBefore - volAfter).toFixed(4) +
                                    'mm3 - rounding a pocket corner can only add material. Piece unchanged' };
      return {
        ok: true, soup: cut.soup,
        stats: {
          radius: clamp.R, requested: R, clamped: clamp.clamped, limit: clamp.limit,
          overreach: planned.over,
          trisBefore: NSO_insideTriCount(soup), trisAfter: NSO_insideTriCount(cut.soup),
          plugTris: NSO_insideTriCount(planned.plug),
          volumeBefore: volBefore, volumeAfter: volAfter, volumeAdded: volAfter - volBefore,
          edgesBefore: before, edgesAfter: after
        }
      };
    });
  });
}

/* Status line, in the app's own voice, so a caller that wires this up does
   not invent a second wording for the same thing. */
function NSO_insideCornersStatus(st) {
  var clamp = st.clamped ? ' (asked ' + st.requested.toFixed(2) + ', clamped to the pocket)' : '';
  return 'corners+edges setback R ' + st.radius.toFixed(2) + clamp +
         ' inside - 4 pocket-floor vertices, 4 floor edges, wall edges left square, rim left sharp (' +
         st.trisAfter + ' tris, one bake from source)';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NSO_insideOverreach: NSO_insideOverreach,
    NSO_insideTriCount: NSO_insideTriCount,
    NSO_insideVolume: NSO_insideVolume,
    NSO_insideEdgeScore: NSO_insideEdgeScore,
    NSO_insidePocketBox: NSO_insidePocketBox,
    NSO_insideClampR: NSO_insideClampR,
    NSO_insidePlanPlug: NSO_insidePlanPlug,
    NSO_insideCornersBake: NSO_insideCornersBake,
    NSO_insideCornersStatus: NSO_insideCornersStatus
  };
}
