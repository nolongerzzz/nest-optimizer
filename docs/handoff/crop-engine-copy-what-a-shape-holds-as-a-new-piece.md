## Crop engine - copy what a shape holds as a new piece (2026-10-17)
Branch `claude/crop-engine`, off `claude-wip` at d333fce. Ticket 1 of 2: the
engine; the card that replaces the old one is ticket 2. Full write-up:
**`docs/CROP.md`, "Stage 4: the copy engine"**.
- **What it is:** `nso_crop.js` (`NSO_Crop`, THREE-free but for its last
  section). `plan(piece, shape)` / `run(piece, shape)` / `copy(model, shape)`:
  Box, Cylinder (any axis), Sphere, Piece and Outline, placed freely in 3D
  (centre, half-sizes, yaw). The result is a closed manifold mesh with no
  slivers, added to the plate as `<name> crop N` where it was cut from, one
  Undo. The original is only read: byte-identical after.
- **Outline** is the footprint of a chosen piece (silhouette, or a rim loop
  found from a triangle), offset out by d1 and in by d2 - the band between - and
  extruded between z1 and z2. d1 = d2 = 0 is the exact footprint.
- **The old card keeps working on top of it:** `app-crop.js` section 6
  (`NSO_cropShapeRaw`, the cutter preview, `NSO_cropPlateToRaw`,
  `NSO_cropMeshSoupP`) delegates to `NSO_Crop`; the card's own words are what
  stayed. `crop:test`, `crop:move`, `wire:crop`, `crop:shapes` pass unchanged.
- **A bug on the way:** the old `NSO_cropMatInvert` transposed the rotation.
  Fixed in the engine's `matInvert`, which the old card now uses.
- **PAINT SCOPE:** none - nothing is written to the original, and the copy
  carries no paint.
- **Checks:** new `crop:engine` (volumes against an independent ray-cast
  oracle, exact identities, `mesh_validate.py`, the real app). `?v=`:
  `nso_crop.js` cropengine1 (new), `app-crop.js` cropshapes1 -> cropengine1.
  `npm test` was not run, as asked.
