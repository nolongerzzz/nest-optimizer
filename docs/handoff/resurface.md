## Resurface - fill / repair any surface work (2026-10-31)

Write-up: `docs/RESURFACE.md`. New: `nso_resurface.js` (THREE-free engine, loaded after
`nso_text.js`), `tools/nso_resurface_test.js` (`resurface:test`, testSteps).
`nso_text.js` gains `capLoops(loops, fr, at, opts)` (cap any boundary loops in 3D
with a height function; Remove's `caps` internals unchanged) and exports for it.
`app-text.js`: Text -> Remove falls back to `NSO_Resurface.plan/apply` when
`pockets`/`caps` fail (`pl.resurface`); no ghost for it, the readout says what it
found. Undo `textReplace`.

PAINT SCOPE: unchanged - **WHOLE-PIECE**, the existing Text stand-down
(`nsoMaskCount(m) > 0`) is before the fallback.

- **Rays, not the recess's own triangles.** The heightfield is the only thing read
  from the work; walls in it find the pits, the ring of face fits the surface to
  return to, and the skin is replaced triangle-wise (no boolean, so no slivers
  and nothing asked of a self-piercing mesh).
- **Splinter islands** shut in by the dropped triangles are taken with the work
  (limit: 400 triangles and a quarter of what was dropped) or the cap sees a
  loop of no area and cannot be triangulated. This was the hand's whole problem.
- **Through holes**: `_g.B` (underside to return to) and `hnear`; top and bottom rims
  are capped separately, the bottom in a frame turned about e1.
- Tested on a slab (word / trench / hole), a faceted cylinder, a piece with another
  shell piercing it, a split-triangle mesh; the hand itself is the user's
  upload and is not in the repo (148k triangles) - numbers in the doc.
- Not yet: raised work, its own card with a flow-up preview, a drive-check step for
  the fallback (it needs a mesh whose rim will not cap; the fixture is the hand).
