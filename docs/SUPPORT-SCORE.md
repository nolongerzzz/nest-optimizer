# The plate score

`tools/nso_support_score.js` generates the six pieces of `fixtures/supports/supp_ref.3mf`, slices them here, and scores each against
Bambu Studio's own slice of the same file by the diff G-scope's Compare > Measure reads (`nso-gscope-diff.js`). One table, so a change that
mends one piece shows what it did to the others.

    NSO_SCORE_REF=supp_ref.gcode.3mf npm run support:score          # against tools/support-score-baseline.json
    NSO_SCORE_REF=... node tools/nso_support_score.js --json out.json --piece Oblique

The two are put in one frame by the centre of the part's outer wall. Columns:

- **foot IoU** - the interface + transition drawn 1.6 mm wide (lines 0.46 apart are one sheet), material both have over both-or-either. 1.0 = the
  same ground. The plate is what touches the model and has to break away, so this is the one to raise.
- **line IoU** - the same with the lines at their own width: harsh, a different zig-zag in the same ribbon scores low. Watch it, do not chase it.
- **len** - our line length over theirs. **mv/mm** - our moves per mm of line over theirs (high = lines chopped into short moves).
- **z0** - the first plate layer, ours / theirs. **tree IoU / tree len** - the same for the Support tree.

- **vol IoU** - the same in 3D (lines fattened to 1.0 mm, 0.2 mm cells, 0.05 mm z bins): grid-independent, so it does not mind which layer height a
  support is cut at. The honest number when the two sides' layers are not the same thickness.

Supports are cut on their own layer grid (Bambu's independent support layer height): `supportLayerMaxMm: 0.28` in the slicer (default 0 = off, the part's
layers) gives each support its own planes - z0 0.2, anchored at each sheet's top and the last layer, each stretch split into equal steps of at most 0.28
(about 0.2755 on the Base) - and the G-code is merged by Z. The card's Dense sheet is laid at 0.275 per layer (`SHEET.denseSheetLayerMm`; 5 layers,
1.375 mm, as Bambu's), G-scope's Slice turns the grid on for such a support. `NSO_SCORE_FLAT=1` scores with the grid off.

A plate that steps (a dome's flank) is laid in bands on the same grid: the lowest stack's top is the anchor, a stack is the 5 grid layers under a cell's
top (1.375 mm at the low end, 1.0 above the anchor), and the slicer's own typing then finds the 2 transition and 3 interface layers of each column. A stepped plate
higher up, above an anchor, stays on the part's 0.2.

Baseline (the build of 2026-10-30, Dense, 30 deg, own grid on): the plate starts where Bambu's does on all six (z0 matches); foot IoU 0.89 on the Base,
0.67 / 0.63 on the Negative Spheres, 0.57 Circular and Sphere, 0.55 Oblique (its stair is not on the grid yet). The Circular's plate stops a layer short of
Bambu's ring round the cone flank (the card's footprint ends there); the Oblique's moves are 4 x shorter than Bambu's (its walls are cut into 2-point pieces,
Overhang wall / Outer wall by turns, where a stair's slotted section is traced) and its plate is a ladder of rungs where Bambu's is one ribbon; the tree
matches least (IoU 0.10 - 0.18).
