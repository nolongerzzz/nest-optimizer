## Standing rule — non-solid is the user's call, never the mesh's (added 2026-09-16)
A piece can be flagged **non-solid** (the *Non-solid* checkbox, `m.nonSolid`,
`nsoNonSolid(m)`), meaning it is meant to be open: a vase-mode clip, a
single-wall squishy, a woven sheet of separate strands. Same shape as paint:
per piece, user-set, visible (list tag + checkbox + status lines), undoable,
never inferred from an edge count. What it lifts is exactly one thing, the
"fully enclosed" requirement — hole fill, flap and orphan peel, open-edge
verdicts, volume-based budgets. **Self-intersection, degenerate, non-manifold
and winding checks run unchanged with the flag on.** Full audit, the split per
consumer, and the wall/gap check for thin shells: `docs/NON-SOLID.md`. A new
consumer states `NON-SOLID SCOPE` in its source and reads `nsoNonSolid(m)`;
`node tools/nso_open_flag_test.js` pins it.

Pass/fail for a flagged piece is `tools/mesh_validate.py --gate --non-solid`
(open edges leave the verdict, the wall/gap check joins it), or
`tools/stl_watertight_check.py --odd --degen --non-solid`.

**Corollary, added 2026-09-17 after it bit:** standing a closure stage down
never licenses the stages that keep running to leave the surface **more open
than they found it**. `NSO_Repair`'s degenerate strip opens boundary as a side
effect of doing its job — a zero-area sliver is usually the stitch holding a
coarse edge to the two finer ones it was split into — and with hole fill
skipped there was nothing left to put those seams back, so the final odd-edge
gate discarded the whole repair. On `fixtures/tape_welded_clustered.stl` that
cost 295 degenerate strips, 288 T-junction splits and a 56-pair drop in
self-intersections, over 15 edges the repair itself had opened. The rule the
flag actually encodes is: **a stage may undo damage this run did; no stage may
close, peel or drop boundary the piece arrived with.** `commit()` records the
arrival boundary before any stage runs and `seam-reclose` closes only loops
containing none of it. If you add a flag consumer that DELETES geometry, this
is the half of the rule that is easy to miss.
