## Cut: a sized blade - cut between things, and notch into a face without going through (2026-11-02)

Write-up: `docs/CUT-BLADE.md`. New: `nso_notch.js` (the blade box, THREE-free), `tools/nso_notch_test.js` (`notch:test`, node, real manifold kernel),
`tools/nso_cut_notch_drive_check.js` (`notch:drive`, real Chromium, 35 gates). `app-cut.js` gains the sized-blade state, `cutBladeSpec`,
`cutBuildSizedBlade` and `cutNotchAt`; `getCutPlaneLocal` returns `upCut` and `blade`. `app-core.js`: the click records its point and face normal
(`state.cutBladeAt`) and one undo label (`notchReplace`). `app-join.js`: `cutActiveModel` branches to `cutNotchAt` when `info.blade` is set; the card
is wired next to the mitre dial. `index.html` the Blade rows and one script tag; `styles.css` a few rules.

The full blade is byte-for-byte the old path (`info.blade` is null unless "Sized blade" is pressed), and every existing Cut test passes. One test
changed on purpose: `nso_wire_cut_redesign_test` pins the exact list of controls on the Cut card, which now includes the Blade rows.

Found while testing: a bevel pivots the plane about the piece's centre line, so the plane is not where the click was; starting the blade from the
click's depth buried it (a void, "2 bodies", 24 mm^3 instead of 18). The anchor is now the clicked face's plane met at the cut plane. A mitre turns
about the vertical and could not show it - the bevel gate is what caught it.

Known gaps (also in the write-up): no wall-thickness refusal (Carve has one), position is by click only, no pocket into a face parallel to the plane.
