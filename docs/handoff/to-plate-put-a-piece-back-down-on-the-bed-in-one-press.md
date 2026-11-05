## To plate - put a piece back down on the bed, in one press (2026-09-20)
`bringSelectedToPlate` (`app-core.js`) behind `#btn-to-plate` in the viewport
**Move** menu. Check: `npm run to-plate`
(`tools/nso_bring_to_plate_test.js`, in `npm test`).

> **AT MERGE (claude-wip, 2026-09-20).** This ticket was written against a Move
> menu that still had Raise and Lower in it. The Move-vertical ticket retired
> both while this branch was out, so every "beside Raise and Lower" and "2 mm a
> press" below reads against the tree this was built on, not the tree it landed
> in: the vertical axis is the Vertical checkbox, its slider and the arrow keys
> now, at 0.25 mm a press. The argument for To plate survives the change intact
> and gets stronger - eighty arrow presses rather than eleven - because the
> thing it is for is the free rotation no vertical control can restore, and the
> slider writes `liftY` through `applyMeshRotation` exactly as Lower did.
> `#btn-to-plate` was added to app-poslock's `ADJUST_IDS` and to
> `updateAdjustUI`'s roster on the versions of those lines that no longer name
> `btn-raise` / `btn-lower`; section 4's Lower control and section 7 now drive
> `liftSelected` directly, which is the surviving function and the idiom the
> other suites already use.

Nothing put a piece back on the plate. Raise and Lower step 2 mm a press, so a
piece Seat (support) has stacked on a 20 mm target - `liftY` 20.18 - is eleven
presses from the bed, and a piece a seat left in the air over a target that has
since been moved or deleted has nothing under it at all. Lower also goes through
`applyMeshRotation`, so on a piece the seat laid on a slope its first press
throws that angle away (see the known-unfixed note above) and the piece is
still in the air.

This goes through `settlePlacedOnBed`, which measures the piece's own world box
and only ever writes `y`: the lowest point of the piece lands on the bed
baseline from any pose, `liftY` is set to 0 so the record agrees afterwards, and
`x`, `z` and the piece's rotation are untouched. A piece pushed out of the build
volume comes back inside it, because `settlePlacedOnBed` clears `overflow` and
`meshOffsetY` with it. One Undo, like every other pose button; a piece already
on the plate is told so and pushes no undo entry; a locked piece refuses it the
way it refuses Raise and Lower, button greyed and action standing down.
