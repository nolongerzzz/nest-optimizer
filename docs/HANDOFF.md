# Handoff (Claude Code reads this. User does not paste code.)

Branch: `claude-wip` only. Never push `main`. Never merge PR #4.
After every pass: comment counts on PR #4.

## Output protocol — standing, all tasks, no exceptions
1. Findings, numbers, diffs and next-step proposals go ONLY as comments on PR #4.
2. Chat carries exactly one line: `Task complete: See PR` or `I need your attention`.
3. No code, tables, dumps or explanation in chat.
4. Never apply `stash@{0}` or any parked patch unless a Grok comment on PR #4, or
   this file, says **APPLY**.
5. Never touch `main`. Never merge PR #4. `claude-wip` only.
6. Never bump `?v=` tags — Grok owns the HUD string.
7. Pass/fail is math: `tools/stl_watertight_check.py --odd --degen` plus the
   geometry probes the current ticket names (lid on cut plane, corner pullback
   vs wall mid). Never call a mesh correct from a screenshot.

## Ping pong
A bare STL drop, no text, is the latest live export for the ticket below.

- Run the checker and the ticket probes.
- Comment the numbers on PR #4.
- Ticket fails -> one scoped patch on `claude-wip`, comment what changed,
  then `Task complete: See PR`.
- Ticket passes every named gate -> comment "this is correct" with the numbers,
  no further patch, then `Task complete: See PR`.
- A decision is needed (scope, APPLY a stash, new ticket) -> comment the question
  on PR #4, then `I need your attention`.

## Standing ticket — Soften Corners: local corner fillets shipped, awaiting live test

Corners no longer runs through the shared cap-plane edge engine. It has its
own path, `rawCornerFilletInPlace` in `app-cut.js`, wired from
`softenSelectedFace`. The edge engine (`rawEdgeRoundInPlace`) is untouched and
still serves Round and Bevel — verified byte-identical output before and after
this change at R=0.5/2/3 on box-20mm.

What the corner path builds, per real corner of the cap boundary (interior
angle t, clamped radius R):

- `C` fillet centre, the inward mitre point: R from both edge lines,
  R/sin(t/2) from the apex.
- `T` two tangent points at R/tan(t/2) along each edge. Outside T..T nothing
  moves at all.
- `P` the new cap boundary is the ARC of radius R about C — the corner is
  round in plan, not a mitre and not a chamfer.
- `F` the feet, the original boundary between the tangent points.
  h(F) = |F - C| - R is the local depth: 0 at both tangent points, largest at
  the apex (0.4142 R for a 90deg corner).

Corner surface = the quarter round from F (depth h, on the original wall) up
to P (depth 0, on the cap plane), swept along the arc. The lid loses only the
crescent between the original corner and the arc; every other lid triangle is
passed through, the bitten ones are TRIMMED by convex clipping, not re-fanned.

No second plane. No re-clip of the body. No full-loop offset. No rebuilt lid.

### Measured on box-20mm, Square split, Corners, cut face

```
R      lid area   exact      centre star  mid-edge on plane  rollover  odd edges
0.5    399.780    399.785    none         4/4                0.2071    0
1      399.119    399.142    none         4/4                0.4142    0
2      396.476    396.566    none         4/4                0.8284    0
3      392.072    392.274    none         4/4                1.2426    0
```

"exact" is 400 - 4R^2(1 - pi/4), the area of four corner crescents; the
residue is arc chording. Tangent point tracks R exactly: (10, 10-R). Radius
clamps at 9.0 (0.45 x 20mm wall) and the status line now says so.

Fixes found on the way, all measured:
- `rawLocalThickness2` skips every segment within two indices of the vertex,
  so on a 4-vertex loop it skips the whole loop and falls back to its 4mm
  default — pinning every corner at R=1.8 whatever R was asked. The corner
  path uses `rawCornerWallLimit2`, which skips only the two segments touching
  the apex. `rawLocalThickness2` itself is untouched.
- Corner detection window was `R*1.5` unbounded; at R=9 on a 20mm square the
  window spans whole edges, mid-edge vertices read as turns and all four
  corners merge into one group — one corner treated, three left sharp. Now
  bounded to total/16.
- Fanning a trimmed lid piece from vertex 0 orphans a boundary edge whenever
  three of its points are collinear (a lid edge carrying a wall vertex). The
  fan apex is now chosen so no fan triangle is degenerate.
- rawCut leaves zero-area seam triangles behind (box-20mm carries one across
  y=10) and they are load bearing. Wall triangles nothing moved are now
  copied through verbatim, area test and all.

### Fail-safe
Every refusal happens before the caller swaps geometry, so the piece is left
untouched: no corner over 30deg, no corner that takes R, a trim that escaped
its corner (area check against the exact crescent), and a final seal gate that
refuses any result with more odd edges than the input. Re-running Corners on
an already-rounded face hits that last gate and refuses, which is correct —
the live path replays from the captured source, not from the output.

### Still to test live
20mm cube, Square split, Corners, R=2.0, one end. PASS is four rounded
corners, four straight edges still on the cut plane, no centre star.

### Known, not this ticket
`rawCapFaceContext` still throws `branch point in cap boundary` on some cut
faces (the parked `stash@{0}` item below). Reproduced on a 20x8 slab — Round,
Bevel and Corners all refuse there identically, so it is the shared boundary
walker, not the corner path.

### Later, not this ticket
Edge R and corner R as two parameters over one unrounded source, one bake.
The edge path is deliberately still in place for that.

## Open, not authorised — need an explicit APPLY

1. **`rawCheckWatertightQuick` tolerance.** It passes a mesh with up to 208 odd
   edges, so the in-app gate reported "Soften ok" on the old 24-open-edge result.
   Validation gap, not geometry. Needs its own pass.
2. **`stash@{0}` — cap/wall boundary-pairing fix.** Parked, unapplied. On some
   real cut faces the cap boundary pairs against the wall on only part of its
   edges (a wall triangle with a single vertex on the cap contributes no
   cap-plane edge), so the loop walk dies with a false `branch point in cap
   boundary` and all three treatments refuse to run on a sound mesh. Reproduced
   on an earlier uploaded piece. Not applied — awaiting APPLY.

## User role
Steer + live click test only. No file upload. No snippet paste.
