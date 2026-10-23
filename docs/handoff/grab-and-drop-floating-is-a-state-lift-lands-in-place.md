## Grab and drop; floating is a state; Lift lands in place (2026-10-15)
Branch `claude/grab-drop`, off `claude-wip` after #189. Full write-up: **`docs/GRAB-DROP.md`**.
- **Grab and drop** (`app-grab-drop.js`, new): press on any piece and drag; it
  follows the pointer, itself looked through. Let go over a piece: seated onto
  it at that point at the Seat gap (`NSO_seatPieceAt`, Seat here's seat
  without the Join session); over the plate: on the plate there (app-core's
  move drag, unchanged); over nothing: left in the air. Escape puts it back;
  each drop is one Undo; it never fuses. Refused in words: onto a support
  piece, onto itself. A press is a carry after 3 px.
- **Floating is a state:** liftY = lowest point - 0.2, kept by nudges, the
  vertical slider, Rotate, Tip and Seat here; only To plate or a drop onto
  the plate brings it down. Undo of a removed piece now honours liftY.
- **Lift lands in place** (`app-lift-plate.js`, `landInPlace`): a lifted
  feature stays exactly where it stood, in the air when it stood on
  something, instead of on free plate beside the parent.
- **Seat here:** its seat factored out as `NSO_seatPieceAt`; Seat here's
  behaviour and words unchanged. New undo label `dropSeatReplace`.
- **Checks:** new `grab:drop` (hinge-plate fixture, 1280 x 800); `lift:plate`
  updated for in-place landing. Static expectations updated, not run on this
  ticket: `lift:drive`, `lift:auto-drive`, `lift:curved-drive` (they asserted
  "on free plate beside it").
- **Tags:** `app-core.js` liftplate1 -> grabdrop1, `app-seat-surface.js`
  seatsurf2 -> grabdrop1, `app-lift-plate.js` liftplate1 -> grabdrop1,
  `app-grab-drop.js` new at grabdrop1.
