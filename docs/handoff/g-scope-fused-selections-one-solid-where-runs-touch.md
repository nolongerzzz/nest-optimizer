## G-scope - fused selections: one solid where runs touch (2026-09-26)
Branch `claude/gscope-multirun-union`, off `claude-wip`. Full write-up:
**`docs/GCODE-MICROSCOPE.md`, "G-scope: fused selections"**.

- **Closes** the solid export's stated limitation: a multi-run selection
  exported as touching shells. **Export as solid** and **Solid STL** now call
  `NSOGcodeSolid.fuseShells`. It finds the real junctions (stacked or side by
  side, `shellContacts`) and unions each connected group in `NSO_CSG`, pair by
  pair and only across a contact. A run touching nothing passes through bit
  for bit. The live Solid view stays unfused.
- **Kernel findings, all measured:** a float32 step between stacked planes
  reads as "no contact", so it is snapped. Zero-volume slivers appear between
  compound bodies; they are dropped. Negative-volume components are enclosed
  cavities; they are kept. The binding's `Manifold.compose` is a union and
  fills cavities. Each group is written to float32 once and then goes through
  the tree's `_finishUnion`.
- **Gated:** every fused body must pass `NSO_Defects.locate` (the checker's
  browser copy). The ways tried are exact → seated 1e-3 mm → stepwise. Beyond
  that, the beads at the located defects are set aside as swept. There is a
  guard at 4,000 runs / 20,000 junctions.
- **Checks:** `gcode:solid` §5 (62 in all) and `gcode:solid-drive` (44). Inner
  + Outer wall PASSES `mesh_validate.py` as one export. Its volume matches an
  independent scanline union to rel 1.2e-7. A single run is unchanged and
  takes 0-2 ms.
- **`?v=` not bumped** (rule 4): `app-microscope.js` and `nso-gcode-solid.js`
  need a bump at merge.
