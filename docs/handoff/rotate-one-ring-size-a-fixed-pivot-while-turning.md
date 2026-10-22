## Rotate - one ring size, a fixed pivot while turning (2026-10-12)
Branch `claude/rotate-fixed-pivot`, off `claude-wip`. `app-rotate-handles.js`,
one guard in `nso-watch.js`. `applyMeshRotation` is not touched.

- **Ring radius is the machine's, not the piece's**: 45% of the bed's shorter
  side from `getCurrentPlate()` (A1 Mini 81 mm, 256 mm beds 115.2 mm; custom
  sizes too). Redrawn on `plate-select` change - which, as always, clears
  the plate (`updatePlateInfo -> clearPlaced`). Arrowheads are 0.18 x radius;
  ticks, tube and label offset were already fractions of it.
- **Fixed pivot while a turn is in hand.** At the press, the pivot is the
  piece's bounding-sphere centre (the geometry's own sphere, the mesh origin
  for a centred load). Each step writes the pose fields and calls
  `applyMeshRotation` as before, then puts the sphere centre back on the
  pivot - the only thing undone is the seat. The piece may pass through the
  plate meanwhile; nothing clamps it. The ring group stands on the pivot.
  "In hand" = a drag, press to release, and a RUN of clicks on one
  arrowhead / presses of one arrow key less than `RUN_MS` (600 ms) apart.
  Put down (`seat()`): `applyMeshRotation` once, and the rings step to the
  seated centre. A drag seats on release; a run 600 ms after its last step;
  teardown, another arrowhead or another ring seats first.
- **Undo** points taken inside a run record `meshY` as the height the pose
  seats at, so Undo always restores a seated pose. A hold that something else
  has re-placed (Undo, another tool) is dropped, never re-seated over it.
- **nso-watch**: the bed check skips the piece `nsoRotate.holding()` names,
  and only that check; a piece lifted with nothing holding it is still caught.
- `nsoRotate.turn` (the Pose buttons' entry) is unchanged: it seats on every
  call, which is the same end pose a held step plus a seat gives.
- Checks: `rotate:handles` sections 13 (rewritten), 17, 18 - 158 gates.
  `rotate:pivot-drive` is the ticket's drive-check, screenshots in
  `tools/rotate-pivot-out/` (git-ignored), not in `npm test`. `?v=`: `app-rotate-handles.js`
  -> rot8 (rot5 / rot7 are the Pose-buttons branch's, #142, merged first).
