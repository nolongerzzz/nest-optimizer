## Punch - the card (2026-10-20)

`app-punch.js` (new), SUBTRACT › Punch; `index.html` (the card under Carve),
`styles.css`, `app-core.js` (`punchReplace` in `UNDO_REPLACE_LABEL`),
`nso_punch.js` (adds `slide`, `cuttersOverlap`, and `frame.o`, `droppedAt`,
`wouldBe` on a plan for the ghost). Checks: `tools/nso_punch_drive_check.js`
(`npm run punch:drive`), a Punch row in `tools/nso_pick_release_test.js`, four
more gates in `punch:test`. `?v=`: `app-core.js` asis1 -> punch1, `styles.css`
bevelb14 -> punch1, `nso_punch.js` and `app-punch.js` new at punch1.
Write-up: "The card" in `docs/PUNCH.md`.

PAINT SCOPE: **WHOLE-PIECE** (header comment + `docs/PUNCH.md`).

- **The card stays armed after PUNCH** - the click goes, the numbers stay.
  Escape (no drag in hand) is what puts it away; the pick:release row reads the
  orbit armed, after PUNCH and after Escape.
- **Handles are read on the click's tangent plane**, the anchor's drag through
  `NSO_Punch.slide`, so the anchor cannot leave the face it was put on.
- **The bar**: a big piece's boolean shows #233's bar from the start (that is
  `NSO_boolRun`'s); Punch adds its own after 300 ms, for the overlap merge and the
  cutters' union, which run before the subtract.
