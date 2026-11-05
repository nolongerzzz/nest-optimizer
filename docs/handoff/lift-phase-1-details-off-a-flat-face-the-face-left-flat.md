## Lift, phase 1 - details off a flat face, the face left flat (2026-10-13)
Branch `claude/lift-flat`, off `claude-wip`. Full write-up: **`docs/LIFT.md`**.

- **One question, not a catalogue:** `nso_lift.js` asks "what sticks out from
  this face, and by how much". Base = the coplanar patch round the click
  (within 1 µm + 2 ppm). Island = triangles with no corner below the plane and
  one above it, joined through edges that leave the plane; liftable when it
  stops all round in the plane and its biggest root loop runs round it;
  offered when it stands out MORE than the slider. Flange / Handle / Bracket /
  Lid / Hinge are untouched.
- **Lift** = island + a cap on its root loops (`rawFlatCapLoops`, so a ring
  lifts as a ring) as its own closed piece; the piece keeps every other
  triangle bit for bit plus the same cap facing out. Undo is Detach's
  `featureSwap` with a new `liftReplace` label; `featureSwap` entries may now
  carry `onUndone` (G-scope redraws after the Undo).
- **UI:** G-scope sidebar, "Features - lift off a flat face": Pick base face,
  How far out counts (default `NSO_Thickness.floorFor(0.4)` = 0.42 mm, flagged),
  click / Shift-click, Lift. Plate pieces only.
- **`nsoFreeSpot(entry, near)`** (app-core.js): Picture's `freeSpot`, moved so
  Lift shares it. `near` defaults to the bed's middle, so Picture's placement
  is unchanged.
- **Paint scope:** whole-piece (roster row above, `nso_paint_scope_test.js`).
- **Checks:** `lift:test` (771), `lift:drive` (58) in `npm test`; `lift:shots`
  keeps screenshots in `tools/lift-out/` (gitignored).
- **Tags:** `app-core.js` land1 -> lift1, then lift2 at the merge with the Cut PR (#149, which had
  taken it to blade1), `app-relief.js` relief2 -> lift1,
  `nso_lift.js` and `app-gscope-lift.js` new at lift1. HUD untouched.
