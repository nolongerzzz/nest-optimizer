## Foam GUN - UI over foamBox (foam-gun-ui, 2026-10-23)
ADD gets a GUN beside Foam: Crop's Box appears on the selected piece (handles size
it, no fields), a held press aimed at the piece through the box sprays foamBox's
foam into its buried space - drawn rising while you hold - and release sets it as
one Undo. Engine is #273 (`NSO_Foam.foamBox`); nothing in `nso_foam.js` changed.
Full description, decisions and limits: docs/FOAM.md section 11.
- **Files.** `app-foam.js` (the gun; `ghost`/`localGeo` take the piece they draw,
  `foamMaterial` is shared with the sealed Foam), `app-crop-card.js` (a loan API,
  `lend` / `release` / `bodyHit` / `box` / `refresh`: the card plans nothing while
  lent, the body does not slide, its own shape is set aside and put back),
  `app-input-mode.js` (leave-tool puts the gun away), `index.html` (`#btn-foam-gun`
  in Foam's row, `#foam-gun-panel`), `styles.css`.
- **Unchanged.** The Foam button and its panel, Fill / Densify, Thicken, Extend,
  Bridge, Close, Patch. The sealed-hollow Foam still says "open to the outside" for
  a cup; the gun never asks that.
- **Decisions.** Owner chose "swap" for Foam while a box is out (each puts the other
  away). Mine: handles only move the box (body-drag is the spray's press); aim = the
  ray passes through the box and meets the piece; 3 s for amount 0..100; Escape in
  the middle of a spray sets nothing; the readout is `+N mm³` or foamBox's refusal.
- **Checks.** `foam:drive` sections 10-15 (GUN shows the box; the handles size it with
  a real mouse; hold fills, release sets, Undo restores; a second spray stacks; Escape
  and Cancel clear, Foam and GUN swap; box_closed fills with no flag, +46,166 mm³).
  Screenshots (box placed, mid-spray, set) are written to `tools/foam-gun-out/` by
  `npm run foam:drive`; the folder is git-ignored, so they are not committed files.
  Gate at the rebase onto 9c6230f: `page:manifest` plus the steps `run-tests.mjs --touching`
  lists for each changed file; `foam:drive` is a drive, not part of the gate. `pick:release`'s roster has no GUN row (the drive
  checks the controls come back after a spray and after Escape).
- `testStepWeights` `foam:drive` 77350 -> 165000 (97 s on this box with sections 10-15, x1.7).
