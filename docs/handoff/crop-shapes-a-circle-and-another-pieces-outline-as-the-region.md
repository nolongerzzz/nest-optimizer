## Crop shapes - a Circle and another Piece's outline as the region (2026-10-16)
Branch `claude/crop-shapes`, off `claude-wip` after #191. Full write-up:
**`docs/CROP.md`, "Stage 3: Circle and Piece"**.
- **What changed:** the Crop card's first row picks the region: Box (the slab
  crop and Move, unchanged), Circle or Piece. Circle is an upright cylinder
  (Click centre, press and drag out, or type Ø; drag its middle / rim). Piece is
  another piece's outline seen from above, Grow ± mm. Both: Keep inside / Keep
  outside, one Undo (`cropReplace`, carrying the pose so the kept part stays
  where it was), refusals in words.
- **Engine:** `NSO_cropShapeRaw` in `app-crop.js` section 6 - the Manifold
  kernel's intersect / subtract against an extruded CrossSection, built in the
  plate frame and moved onto the raw soup by one transform. Headless.
- **Checks:** new `crop:shapes` (71 gates). Only it and `page:manifest` were run
  for this change; Box's `crop:test` / `crop:move` / `wire:crop*` were not.
- **Tags:** `app-crop.js`, `styles.css` -> cropshapes1.
