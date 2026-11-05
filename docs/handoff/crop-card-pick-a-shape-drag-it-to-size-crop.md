## Crop card - pick a shape, drag it to size, CROP (2026-10-17)
Branch `claude/crop-card`, stacked on `claude/crop-engine` (#222), ticket 2 of 3.
UI only: the engine is #222 as built, plus `planOn` / `resolve` /
`footprintPolys` for the card. Full write-up: **`docs/CROP.md`, "The card"**.
- **What it is:** the Crop card is a Shape row (Box, Cylinder, Sphere, Piece,
  Outline), one readout line, CROP and Cancel - nothing else (`page:manifest`
  gates it). The shape is placed and sized by dragging handles in the viewport
  (`app-crop-card.js`), in Rotate's rails look, hit areas 14 px on the screen.
  The readout follows live from `NSO_Crop.planOn`. CROP is `NSO_Crop.copy`: the
  copy lands in place, selected, one Undo; the shape stays for another crop.
  Escape / Cancel / closing the card put it away.
- **Where each old control went** (also in `docs/CROP.md`): Crop X / Z and the
  from / to fields -> the dragged Box; Circle -> Cylinder; Piece region -> Piece
  shape (Grow -> Outline's offsets); Keep outside -> gone (Subtract the copy);
  Move region (Up / Across / Lift / Lock in) -> removed from Crop with
  `NSO_cropMoveRaw` and `NSO_Crop.cut`: CROP, grab the copy, JOIN; Detach flange
  -> the Subtract card under Split to parts; Reattach -> the Connect card, last row (same ids).
- **Retired:** `crop:move`, `wire:crop-move` (and their test files). Their cases
  tested `NSO_cropMoveRaw`, which is gone; the kernel unions are Join's.
  `nso_detach_test.js` lost its comparison against Move.
- **Rewritten for the new card:** `wire:crop`, `crop:shapes` (same names, same
  independent measurements: the disc's radius, the star's outline; the old card's
  Keep outside / Grow cases have no equivalent). Updated: `shell:v3`,
  `helpers:teardown`, `wire:cut-redesign` §7, `wire:detach`.
- **Two bugs the card exposed, fixed in `app-core.js`:** Undo of an `addModels`
  step with a cutter open, and an import while a cutter is open, both rebuilt the
  plate from a single piece (`showEditPreview` empties `state.placed`). Both now
  skip it when the cutter is Crop's.
- **New:** `crop:drive` (`tools/nso_crop_card_drive.js`, real mouse drags).
  **?v=** `nso_crop.js`, `app-crop.js`, `app-crop-card.js` (new), `app-core.js`,
  `styles.css` -> cropcard1. `npm test` was not run, as asked.
