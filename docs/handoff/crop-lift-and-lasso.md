## Crop card - Lift (with Detach flange) moves in, Lasso is a new shape (2026-11-07)
Branch `claude-wip`. Full write-up: **`docs/CROP.md`, "The card"**; Lift's side in **`docs/LIFT.md` section 7**.
- **Lift moved from Subtract to Crop**, as a button that reads like CROP (full width, lit while open). Pressing it
  opens its panel in the card - count, *How far out counts*, Strip, **Detach flange** and its readout - and pressing
  it again folds the panel away. Detach flange is now part of Lift (inside `#lift-panel`; `btn-detach` and
  `detach-readout` kept). Subtract is Subtract B from A, Extract bit (with Carve), Punch, Hollow, Split to parts.
- **Lift and a shape never run together:** Lift armed puts any Crop shape away, picking a shape folds Lift away,
  shutting the Crop card folds Lift away. With the Crop card open a press on a piece only picks it; the one exception
  is a piece Lift left in the air, which can be grabbed and dropped (`startMoveDrag`, `cropYieldsToLifted` in app-core).
- **Lasso** is a sixth shape: drag a loop round what to copy on the screen (Alt-drag orbits). The loop is the rays
  through its corners from the camera it was drawn in - a cone - so the copy is what the loop sees, front to back.
  Engine: `{ kind: 'lasso', eye, dirs, near?, far? }` in `nso_crop.js` (extrude with a top scale, so it is exactly a
  frustum). A loop that crosses itself is widened 5 microns so the copy closes.
- **Gates:** `crop:engine` 6b (frustum closed form, 296 ok), `crop:drive` 8 and 9 (real-mouse lasso; Lift opens, folds,
  Detach runs inside it, Lift/shape exclusivity), `page:manifest` (the Crop card is the Shape row, CROP, Cancel and the
  Lift package), `subtract:card`, `shell:v3`, `ui:shell`, `wire:detach`, and the Lift drives (their Lift button is in
  the Crop card, which stands over the left of the view: `nso_lift_plate_drive_lib.js` `setClearOfCard` slides the
  picture right for the ones that click on a piece).
- **Known, not from this change:** `shell:v3`'s CLEAR PLATE check fails on the branch before it too.
