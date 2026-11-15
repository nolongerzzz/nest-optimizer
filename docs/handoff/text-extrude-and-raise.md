## Text - Extrude (raised text) and Raise (lettering already on the piece) (2026-11-15)

Write-up: `docs/TEXT.md` (sections Extrude, Raise). Files: `nso_text.js`, `app-text.js`, `index.html`
(the card's rows), `styles.css` (`.is-raise`, `.text-raise-only`), `tools/nso_text_test.js` (gates 11, 12),
`tools/nso_text_drive_check.js` (steps 4b, 7c). No new package.json step.

PAINT SCOPE: **WHOLE-PIECE** (`nsoMaskCount(m) > 0`), as the rest of the card; RAISE stands down the same way.

- **Extrude** is the emboss the first cut left out: `plan(..., { raise: true })` gives a solid from 0.2 mm
  inside the face to Depth above it (both ends follow the surface), `NSO_unionSoups` joins it. The card's
  Engrave | Extrude switch renames the Depth row to Height and STAMP to EXTRUDE. No wall rule (nothing is cut).
- **Raise** came from an owner file: a MakerWorld dust cover whose "REMOVE BEFORE PRINT" is 17 patches
  0.01 mm under the face carrying Studio's `paint_color`. NSO reads no colour, and Remove's scan (0.12 mm
  grid) cannot see a 0.01 mm wall, so the letters were invisible. `NSO_Text.islands` reads them off the
  triangles; `lift` moves their corners (walls stretch and flip by themselves). On that file: 25 patches
  (17 letters, 8 counters), one click per word at Reach 3, +136.2 mm3 at 0.6 mm, closed before and after.
  The file itself is not in the repo (someone else's model); gate 12 builds the same thing with the
  shipped subtract at 0.01 mm.
- **Whole word** measures the real gap (corner to edge), not bounding circles: tall letters' circles overlap.
- **Not done:** colour paint itself (read / show / write `paint_color`, per-face filament); Raise on curved
  faces; that file's label is on the face that sits on the bed, so raised letters there want the piece
  turned over (or a negative Height, which engraves them).
- `npm test` was not run in full; `text:test`, `text:drive`, `page:manifest`, the paint-scope roster,
  the pick-release Text row and `run-tests --check` were.
