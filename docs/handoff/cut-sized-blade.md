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


### Second round (2026-11-02): strands, Notch mode, Adjust blade, Rotate piece

Asked for after the owner loaded `Connector (string)` (a flat spiral of 3.7 mm round cord): a sized blade that takes the one strand under the click and
not every turn of the spiral; a Notch mode (a nick in from the strand's edge, adjustable width/depth - the owner chose the nick over a groove running
along the cord); a checkbox to isolate blade adjustments from other controls (dropped in the third round - see below); and a rotate box at the top of the card so a piece can be turned while Cut
is open. `nso_notch.js` gains `sectionClusters` / `nearestCluster` / `notchBox` (node-tested on a comb). `app-cut.js`: three blade modes, the strand in
`cutBladeSpec`, the strand outlined in the helper, `cutSetRotate`. `app-core.js`: the ring grab is allowed under Cut when `state.cutRotate`. `app-rotate-handles.js`: rings drawn/grabbed under Cut, keys stay
with the Rotate menu. New `tools/nso_cut_strand_drive_check.js` (`notch:strand-drive`, a generated spiral). `nso_wire_cut_redesign_test` lists the card's
controls again.

Found on the owner's file: subtracting the strand's own piece (blade n piece) from the piece left one edge shared by four triangles (a boolean on
coincident faces; 0 non-manifold before, 1 after, at every tolerance, kernel status NoError). The blade, clipped a hair outside the strand, is subtracted
instead: same volume, 0 bad edges. Also found: a click-to-strand pick measured to the outline's corners picks a neighbour on coarse meshes; it is now
measured to the outline's segments.

Known gaps: no wall-thickness refusal; Notch is a nick across the strand, not a groove along it; position by click only.

### Third round (2026-11-03): Adjust blade dropped, sizes are sliders

The owner dropped the Adjust blade switch (it was meant to keep other controls from shifting the blade; sliders for the sizes are the answer) and asked
for a slider for width, depth and kerf on the Sized blade and the same for Notch. Adjust blade is gone from the card, `app-cut.js`, the three gates in
`app-core.js` and the tests. Each size is a slider + number box (`CUT_BLADE_FIELDS`), ranged to the piece (`cutSliderMax`), and the range always takes in
the number shown. `nso_wire_cut_redesign_test` lists the new card; `nso_cut_strand_drive_check` (47 gates) has the slider gates, including a real mouse
click on a slider and a computed-style check that the ring options are hidden until Rotate piece is ticked (the owner's screenshot showed them up).

### Fourth round (2026-11-03): the finger would not separate; a bevel sent the blade flying

Reported on `Cartoon-Hand_..._DukeDoks part 2` (and then the file, as `text_repair_test.3mf`, so it could be reproduced): a sized cut through a finger was
called a "Notch cut", left the finger as one piece, warned of 25 open edges, and Split to parts then refused ("part 2 is too small"); a bevel sent the
blade flying round the piece.

- **Wording**: `Sized cut` / `Notch cut`, by mode.
- **Separation**: a severing cut now runs Split to parts (`NSO_SPLIT_PARTS.split({ absorbDust, quiet })`: a part under 0.1 mm across is folded into the
  largest part instead of refusing the lot; quiet reports by return value). Its own Undo step. A button click is unchanged.
- **Flying blade**: `cutPivotLocal` returns the blade's own centre for a sized/notch blade, so mitre and bevel turn it in place (it was swung about the
  piece's centre line, up to 13 mm off). `nso_cut_sever_drive_check` holds the blade to its click through bevel -90..90 and mitre 0..270, and fails on the
  old code.
- **The 25 edges were not the cut's** (0 -> 20 was the app's count of the kernel's output; the kernel alone, with no blade, gives the same 20 and a
  zero-volume 12-triangle fin: it re-triangulates the flat base's fine detail on import). The warning now compares with the piece as the kernel holds
  it and says so. Not fixed: that is the shared boolean kernel (Carve, Subtract and Punch see it too).
- **Speed**: 42 s -> 19 s on the hand (the edge counts were three 7 s adjacency passes; now a quick counter, and the weld only when worse).
- A surface correction divided by a near-zero face lean at bevel 90 and sent the blade to nowhere ("does not reach the piece"); it now applies only
  where the face leans into the plane.

Four suites that already fail on the commit before this work (`nso_rotate_rings_drive_check`, `nso_rotate_rings_steady_drive_check`,
`nso_rotate_pivot_drive_check`, `nso_shell_v3_test`) are unchanged.

### Fifth round (2026-11-04): room on the sliders

A 15 mm notch could not be dialled in: the kerf and notch-width sliders stopped at 10 mm (`min(10, span/2)`). `cutSliderMax` now gives every slider room to breathe:
width 2x the piece's biggest section, depth 1.5x, kerf and notch width 3/4 of its length, each at least 20 mm. The number box still takes anything and the
range still grows to hold it. `nso_cut_strand_drive_check` (49 gates) sets a 15 mm kerf and a 15 mm notch width by slider.
