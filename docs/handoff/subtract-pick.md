## Subtract B from A - picks its own A and B, no trip to the Join card (2026-11-06)

The Subtract card's first button used to be grey until A and B had been picked on
the **Join** card's slots. It now runs the whole thing itself:

    open Subtract -> press Subtract B from A -> click piece A -> click piece B
      -> move B into A by hand -> press Subtract B from A

- **It is the Join session underneath** (`state.joinSession`, the `joinArmed`
  slots, the click routing in `app-core.js`, the A/B highlights), marked by a new
  `state.subtractFlow`. Nothing in the cut changed: `subtractBFromA`,
  `NSO_punchCore` and the 1.0 mm wall are as they were.
- **`app-join.js`**: `subtractReady`, `updateSubtractUI`, `startSubtractFlow`,
  `subtractPick`, `subtractWireCard`. `assignJoinClick` arms B itself once A is
  taken in a Subtract run. The button is never greyed.
- **The press** is the cut when A and B are both picked (by this card, the Join
  card, or a script setting `state.editId` / `state.joinPartnerId`), so nothing
  that drove the button before changes. Otherwise it starts the picks; pressed
  while it waits for a click it stops them (nothing changed). Fewer than two
  pieces on the plate is refused in words. Carve, Punch and Lift are put away
  first so their click is not taken before the pick.
- **The card** gains `#subtract-readout`, a line under the button (hidden when
  idle) that says what to click or do next, and the button's `.is-armed` look
  (Carve's teal) while it waits. The label is still `Subtract B from A`.
- **When the run ends:** the cut, a second press while picking, Escape / leave-tool
  (`clearJoinSlots`), or no menu left open anywhere. Switching to another column to
  put B in place (Move) keeps it. The "nothing open" look is on every menu, not
  only Subtract's, because a live session switches Brush, Pull and Limb off.
- **Gate:** `npm run subtract:pick` (`tools/nso_subtract_pick_drive_check.js`) -
  real clicks on the canvas, a real drag of B, the cut, Undo, stop, shut, and the
  already-picked path. `subtract:card`, `ui:shell`, `flip:port` and `join:triple`
  still hold. `shell:v3` has one failure that is there without this change
  (CLEAR PLATE "keeps the loaded pieces").
