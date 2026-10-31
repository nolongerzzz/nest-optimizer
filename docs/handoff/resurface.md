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

## Update: hover / lock / pick (2026-10-31)

Text -> Remove is now a selection tool on Resurface instead of "click one recess, get what its click finds":
`NSO_Resurface.scan` reads the box once (`half` 16, ~1 s on the 148k-triangle hand), pieces are numbered, hover
lights (amber) and click locks (green) through `pieceAt` and `highlight`; `NSO_Text.pockets/caps/fill` is no
longer called by the card. `app-text.js`: `state.text.rm = { soup, scan, sel, hover, plan, tris }`; Whole word now
matters (`scan.group(id, reach)` vs the one); Escape clears the lock first. `nsoTextState()` gains `sel`, `hover`.
Why the old behaviour was inconsistent: the box was centred on the click (so letters were cut by it), the axis
was the clicked facet's normal (walls that lean back under a skew axis hide from the rays - 8 letters found from
one place, 3 or 6 from another), and an apply that cut between letters met splinters.
Engine changes that made every subset work on the hand: the axis from the walls; the footprint stops a node
short of other pieces; down-facing fins in the footprint are skin; a hole's window reaches 3 nodes for the wall's
foot; dropped flakes touching no work stay; splinter islands (by projected area) go; the cap tries the rim, then
zips a strip to a clean outline (`zipTop`). The checker's numbers on the hand for each of the 8 letters alone:
open 0, non-manifold 0, flipped 0, flat 0 (piercing pairs fall from 2544 to about 2000-2400, all of them
elsewhere in the model).
