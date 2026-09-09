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

## Standing ticket — Soften Corners, second pass (corners2), awaiting live test

corners1 was measured on the exported STL of the live FAIL. What it actually
built, on the 12.38 x 20 x 20 baked half at R=2.5:

- All FOUR cap-loop corners carried an arc of exactly radius 2.5 (tangent at
  7.5 on each edge, centres at (+/-7.5, +/-7.5)). Watertight, 0 open, 0
  non-manifold. So "one pair only" is not in the mesh — but the shape was
  still wrong, in two ways that explain what it looked like:
- **Orbit-point.** The corner surface converged radially on the ORIGINAL
  sharp apex at depth 1.0355 — every rollover sample ran to one vertex, so
  the corner is a cone apex, not a fillet. From any camera off the face
  normal it reads as a point.
- **Bite too small.** corners1 rounded the lid boundary in plan with radius
  R but only cut the wall back by R/sin(45) - R = 0.4142 R. At R=2.5 that is
  a 1.04mm bite where 2.5mm was asked, which is the "~0.5mm" that was seen.

corners2 drops that separate path entirely and puts Corners back through
`rawEdgeRoundInPlace`, the same engine as Round and Bevel: same loop walk,
same quarter-circle sweep, same untouched cap plane, with one per-vertex
radius array — R at every vertex whose windowed turn beats 30deg, 0
everywhere else. The corner is then the intersection of the two edge fillet
cylinders, which is what a CAD variable-radius edge fillet is: a real
quarter-circle of radius R normal to each edge, and no point.

The centroid fan is gone from the engine for all three treatments. The lid is
now the ORIGINAL cap triangles trimmed back to the ring
(`rawLidTrimToRing2`): loop2[i] pairs with ring2[i], so the strip the ring
took is the band of quads between them, and the lid is the cap minus that
band. Triangles the band does not reach come through untouched; the ones it
bites are clipped, never re-fanned. Convex ring takes the direct
intersection, anything else subtracts the band quad by quad.

### Measured

20mm box fixture, Square split, cut face:

```
R      tris  open  NM  star  lid off capPlane  wall-mid R  corner apex depth  groups
0.5     88     0    0   no          0            0.0000         0.500          4
1.0     88     0    0   no          0            0.0000         1.000          4
2.0     88     0    0   no          0            0.0000         2.000          4
2.5     88     0    0   no          0            0.0000         2.500          4
3.0     88     0    0   no          0            0.0000         3.000          4
```

Attached FAIL STL, its untreated face, R=2.5: 512 tris, 0 open, 0
non-manifold, no star, lid entirely on capPlane (x = -6.1902), 4 corner
groups, R>0 at exactly 4 loop points, peak R 2.500, corner apex depth 2.500,
lid still reaching y/z = +/-10 with the straight span running z = -5..+5
(blend ends at 10 - 2R exactly).

Round and Bevel: lid area now 268.960 against an exact (20 - 2R)^2 = 268.960
at their clamped R=1.80 — the trimmed lid is exact, and their radius clamp is
unchanged (they still use `rawLocalThickness2`; only the Corners filter moved
to `rawCornerWallLimit2`).

### Two engine bugs fixed inside rawCornerRadiiOnLoop2
- radius clamp used `rawLocalThickness2`, which skips every segment within
  two indices of the vertex and so returns its 4mm default on a 4-vertex
  loop, pinning every corner at R=1.8.
- detection window was `R*1.5` unbounded; at large R it spans whole edges,
  mid-edge vertices read as turns, and all four corners of a square merge
  into ONE group. Bounded to total/16.

### Fail-safe
Refusals all happen before the caller swaps geometry: no corner over 30deg,
no safe radius, ring self-intersection, a lid trim that loses area, and a
seal gate refusing any result with more odd edges than the input.

### Known, not this ticket
`branch point in cap boundary` still refuses some cut faces (parked
`stash@{0}` below) — Round, Bevel and Corners all refuse there identically.

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
