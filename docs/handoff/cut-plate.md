## Cut: Whole plate - one level blade across every piece, to shorten a plate of print tests (2026-11-05)

Write-up: `docs/CUT-PLATE.md`. New: `nso_cut_plate.js` (plan / move / range, THREE-free), `app-cut-plate.js` (the card's fields, the blade helper, the press),
`tools/nso_cut_plate_test.js` (`cut:plate`, node, through the real `cutOneSide`), `tools/nso_cut_plate_drive_check.js` (`cut:plate-drive`, real Chromium,
46 gates), `tools/nso_cut_plate_pieces.js` (the T and the standing tube the two build). Hooks, each a line or two: `app-cut.js` (the Blade row's fourth mode,
`syncCutBladeUI`, `updateCutterUI`, `buildCutHelper` and `showEditPreview` stand down, `closeCutter` / `openCutter` drop the blade), `app-join.js`
(`cutActiveModel` hands the press over), `app-core.js` (a click on a piece drops no per-piece blade; `placeNewModel` keeps the plate up; one
`UNDO_REPLACE_LABEL` row, one `REDO_LABEL` row, `redoLabel` read by Redo), `index.html` (the button, the fields, `cut-per-piece` marks, two script tags),
`styles.css`. `wire:cut-redesign` pins the card's control list and now names the new ones.

Asked for after the owner loaded a Bambu `supp_ref.3mf` (six support-reference pieces, 17 mm tall, each a 5 mm pillar under the feature being tested):
"uniformly shorten an entire plate of pieces ... shorten the pillar on all pieces ... a cut plate option, one big blade on a vertical slider, in Cut."
Read as: a level blade at Height mm above the bed, applied to every piece; Keep above drops what is under it and sets the rest back down (the shorten),
Keep below the reverse. Checked on that file: all six 17 -> 12 mm at 5 mm, x / z unmoved, 0 open edges and no more non-manifold edges than before, one Undo.

Decisions: the cut is `cutOneSide` (rawCut + its closed-section check) in the raw frame, so the engine is the one Cut has always used; the commit is
`NSO_sculptCommitRaw` (Crop's), so ids and places stay. Planned and cut in memory first, committed after: one refusal changes nothing. Painted pieces the
blade crosses refuse (a cut renumbers faces; Crop's rule). A turned piece is baked first (`nsoBakePlacedPose`), inside the same Undo, because the blade is
level in the world and the cut is made in the piece's frame. A piece the blade does not clear by 1 mm both ends is left alone and named - a plate of mixed
heights is cut where it can be. The press is one `stepGroup` (the Join presses' `asOneStep` pattern: its own stack, regrouped), so one Undo and one Redo.

Found while testing: Redo tears down every helper session (`nsoHelpers.teardown`), so the card closes on Redo - the same for every tool; the drive reopens it.
`npm run stamp` also moved the `nso_slicer.js` tag, which had drifted before this change (the slicer commit did not re-stamp).

Known gaps (also in the write-up): the bottom of every piece goes with Keep above, foot included - keeping a foot and taking a band from the middle of a
column is Crop's job per piece; level blade only; the active bed only.
