## Lift 2 - auto-aim and Strip (2026-10-13)
Branch `claude/lift-auto`, off `claude-wip`. Full write-up: **`docs/LIFT.md` §5**.

- **The map decides where, the mesh decides what:** `nso_lift_auto.js` rasterizes
  the piece's upward-facing surface looking down the base (0.25 mm cells,
  coarsened in words past 4 M), estimates the base with a rolling ball
  (`NSO_LiftAuto.estimateBase`, the one replaceable function; radius 0.2 of the
  shorter footprint side, 4 - 15 mm), and calls a cell a detail at more than
  0.32 mm (over a print's layer step). Each island is cut at its own plane;
  refused in words past 0.15 mm of bend. The pieces are the real triangles, cut
  with Phase 1's `capFor` / `rawFlatCapLoops`.
- **`nso_lift.js`:** behaviour unchanged; it exports `internals` (`planeFrame`,
  `boundaryLoops`, `capFor`) for Lift 2.
- **UI:** the G-scope section is now "Lift" with Pick | Strip. Pick = Phase 1,
  plus the map on a face Phase 1 calls curved. Strip = groups by geometry
  (small dots / lines & squiggles / large shapes / can't lift), tick boxes,
  Lift N, Remove N; one Undo either way.
- **Paint scope:** whole-piece for Lift and Remove (roster row above).
- **Checks:** `lift:auto-test` (398), `lift:auto-drive` (40) in `npm test`;
  `lift:auto-shots` keeps screenshots in `tools/lift-auto-out/` (gitignored).
  Phase 1's `lift:test` (771) and `lift:drive` (58) unchanged.
- **Tags:** `nso_lift.js` and `app-gscope-lift.js` lift1 -> lift2,
  `nso_lift_auto.js` new at lift2, `styles.css` box2 -> lift2.
