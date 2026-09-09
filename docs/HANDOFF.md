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

## Standing ticket — Soften Corners is a FAIL, REOPENED

The earlier "CLOSED, verified" verdict was wrong. Watertightness was green, but
the shape is not corners. Confirmed by measurement at `7e97c5d`, box-20mm,
Square split, Corners:

```
R=0.5  cap tris on plane 16   star vertex (0.0000,0.0000) used by 16 of 16
R=2.0  cap tris on plane 16   star vertex (0.0000,0.0000) used by 16 of 16
R=3.0  cap tris on plane 16   star vertex (0.0000,0.0000) used by 16 of 16
```

Every cap triangle shares one interior vertex: the whole clicked face is
discarded and recapped as a centroid star. `app-cut.js:2316` — "cap-plane
triangles are dropped" — then rebuilt by the centroid fan at `app-cut.js:2335`.
That is a face rebuild, not a local corner.

Why the earlier passes missed it: the probes only measured lid depth, outline
extent and edge counts. None of them looked at cap TRIANGULATION, and all ran
at R=0.5 where the corner region is 1mm of a 20mm edge. Any future Corners
probe must assert (a) no shared apex across cap triangles, and (b) behaviour at
R=2.0 and R=3.0, not just 0.5.

### Required result
- Long edges of the clicked face stay on the original cut plane.
- Only corners get radius R, clamped to ~0.45 x local wall.
- Face interior not moved, not re-triangulated as a star, not clipped to
  plane +/- R.
- Square split stays raw. Undo unchanged. Fail-safe leaves the piece untouched.

### Forbidden
- `marginPlane = plane +/- R` then re-clip.
- Replacing the whole cap with a fan.
- Calling a full-loop offset "Corners".
- Changing Square cut, Join, Subtract, Thicken, pack.

### Test
20mm cube, Square split, Corners, R=2.0, one end.
PASS: four rounded corners, four straight edges still on the cut plane, no
centre star on that face.

### BLOCKED — needs an answer on PR #4 before code
A second-plane clip is NOT needed; local corners are buildable. The open
question is the corner SOLID, and the two readings give different meshes:
(a) in-plane only — face stays wholly on the plane, corner material is a
vertical wedge running the piece length (rounds the box's vertical edge);
(b) axial rollover local to each corner — straight spans flat on the plane,
corners roll back by R.
Do not write code until this is answered.

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
