## Mold - a two-piece silicone mold from a piece (2026-10-16)
Branch `claude/mold`, off `claude-wip`, independent of the open branches. Full
write-up: **`docs/MOLD.md`**.
- **What it is:** an engine (`nso_mold.js`, THREE-free) and a card (Gen+ ->
  Mold, `app-mold.js`, its own entry beside Wheel, Stock and Picture). Select a
  piece, slide / tilt the blade (the Cut card's slider, ← number →, dial),
  press Generate: two closed, manifold pieces on the plate beside the original,
  `<piece> mold A` / `mold B`, parting face up, keys in, sprue Ø8 and vent Ø3 in.
  One Undo removes both; Regenerate replaces the pair. The piece is untouched.
- **Reuse, not reinvention:** the cavity and the sockets are **Subtract**
  (`NSO_subtractSoups`), the keys are **Union** (`NSO_unionSoups`), the halves
  are **Cut's clean split** (`cutOneSide` / `rawCut`), all handed to the engine
  as a `kernel` so the node tests run the shipped code (`tools/nso_mold_testlib.js`).
- **Locks** (faces that would lock a half) are tinted and counted on the card:
  "N mm² would lock" - a warning, never a refusal. **Refusals** in words: not
  closed; block bigger than the plate (the size is in the text); keys that would
  not fit (the minimum wall is).
- **Interpretations to check against intent:** the Cut card's dial is a heading
  about the vertical, which does nothing to a level plane, so here the dial
  steers which way the blade leans and a **Tilt** field sets how far. "A Stock
  box tilted 20°" is tested both as the blade tilted 20° (the plane follows the
  slider; lock > 0) and as the piece posed 20° on its side. A key is a full
  cone at Ø6 / 3 mm / 45° (apex at 3 mm); the height is held to Ø/2.
- **Paint scope:** none (roster row above) - it reads geometry and edits no
  piece.
- **Checks:** new `mold:test` (85 gates, node) and `mold:drive` (1280 x 800),
  plus `page:manifest`. Nothing else was run on this ticket.
- **Tags:** `app-core.js` liftplate1 -> mold1 (one click-routing block,
  `nsoMoldTakesClick`), `styles.css` liftplate1 -> mold1, `nso_mold.js` and
  `app-mold.js` new at mold1.
