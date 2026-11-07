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
- **Piece is off the card** (2026-11-07): the shape that took another piece as the cutter was left over from another
  build and Box, Cylinder, Sphere, Outline and Lasso cover it. Removed from `index.html` and `app-crop-card.js` (its
  state, readout, overlay and click-pick); the engine keeps `{ kind: 'piece' }` (`crop:engine` 4 still runs it). The
  drive checks that used it now use Box (`wire:crop`'s refusal) or Outline of the star (`crop:shapes`'s refusal).
- **Wall** (2026-11-07), the sixth shape: the manual stand-in for what Lift should find by itself. Click a flat
  wall of the piece; a straight yellow line appears on the wall's outline (outermost loop of the coplanar patch, so a
  bump is inside it); drag the handle, or click the piece (say behind a bump, from the side), to set how far out the line
  is; CROP copies what stands outside it - the bump and nothing else with the line flush - and leaves the original alone
  (Subtract the copy for a clean wall). Shift-click picks another wall. Engine `{ kind: 'wall', ... }` and
  `NSO_Crop.wallFace`; the line is held 0.5 micron outside where it is set (see docs/CROP.md). Gates: `crop:engine` 6c,
  `crop:drive` 5b. One wall at a time; the outline is the wall's own, not editable yet.
- **Wall: the bump fixtures and the curved-surface refusal** (2026-11-07): `fixtures/crop-wall/` has `block_bump.stl`,
  `sphere_bump.stl` and `cone_bump.stl` (made by `tools/nso_crop_wall_fixtures.js` with the app's kernel; closed). Wall
  on the sphere or the cone's slope finds one facet of the curve; it now refuses in words ("that is a curved surface,
  not a flat wall") rather than draw a line on a sliver. The cone's base is a wall (`crop:engine` 6d: 1 mm into it is
  the closed form, within 0.05%). `crop:drive` 5b clicks the sphere and the cone with a real mouse.
