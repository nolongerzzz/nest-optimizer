## Text - type a word, stamp it into a face (2026-10-30)

Write-up: `docs/TEXT.md`. New: `nso_text.js` (THREE-free engine), `app-text.js`
(the card), the **TEXT** button in the left column between SHAPE and PAINT
(`#menu-text`; the menu is the card, opening it arms it). `nso_punch.js` gains
`NSO_Punch.surface(soup, hit, opts)` - the click's frame and a `foot(p)` /
`thickness(c, axis)` probe - which Text reads. `app-core.js`:
`textReplace` in `UNDO_REPLACE_LABEL`; `styles.css`: the Text card's rules.
Checks: `text:test` (`tools/nso_text_test.js`, testSteps), `text:drive`
(`tools/nso_text_drive_check.js`, driveSteps), a Text row in
`tools/nso_pick_release_test.js` (the `cards` step), a Text row in
`tools/nso_paint_scope_test.js` and in the paint roster table.

PAINT SCOPE: **WHOLE-PIECE** (`nsoMaskCount(m) > 0`).

- **The page draws, the engine traces.** A canvas renders the lines in the font
  (so the browser's fonts and a loaded font file both work, and nothing is
  bundled); `NSO_Text.shape` takes its alpha: marching squares, Douglas-Peucker
  with a crossing check, ear clipping with the holes bridged in. Node tests feed
  it synthetic letters; the drive check feeds it the real renderer.
- **The bottom follows the surface.** Depth is square to the surface (depth / cos
  of its lean from the click's normal, never more than 2x), so a cylinder is
  engraved one depth all over. Flat faces keep the unrefined triangulation and a
  flat bottom; curved ones are refined to 1 mm edges.
- **Off the face is refused, not dropped** (Punch drops a hole that falls off; a
  letter cut in half is not a hole). The refusal still draws its ghost, red.
- **The wall floor** is two nozzle widths under the deepest point; the refusal
  says how deep would fit.
- **Armed = menu open.** Opening another menu closes Text (the accordion), and
  Text also puts itself away if Carve, Paint or Punch is armed over it.
- **Remove (added 2026-10-30):** the card's Stamp | Remove switch. `NSO_Text.pockets`
  reads the recess off the piece (floor, walls, rim), `caps` makes the caps and
  `fill` lays them - mesh surgery, not a boolean (a unioned prism left slivers the app's
  checker flags). Flat and curved faces; no stamp history. It stops, in words, on a
  rim that folds back on itself (a splintered scan mesh): `text_repair_test.3mf`'s
  hand is the example. Details and the limit in `docs/TEXT.md`.
- **Not done, on purpose:** emboss (the prism has both ends; a union instead of a
  subtract), wrapping across edges, letter / line spacing, typed font names.
  Listed in `docs/TEXT.md`.
- **Environment note for the next person running the drives here:** the harness
  looks for `chrome-linux/chrome`; this container's Chromium is at
  `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` - `PW_CHROMIUM=...` fixes
  it, and `npm i --no-save three@0.147.0` supplies the CDN copy the harness serves.
- **?v=** stamped with `npm run stamp`. `npm test` was not run in full; the new
  steps, `page:manifest`, the paint-scope roster, `punch:test`, the pick-release
  Text row and `run-tests --check` were.
