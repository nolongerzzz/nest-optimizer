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

On the support grid every sheet layer is typed by the part's nearness, cell by cell (`o.supportLayerMaxMm > 0`): Bambu's top support layer lies a layer and the
gap (0.4) under the part, a layer is interface while the part is within that + 2 of its layers over it, transition within 2 more - a slope's cells one by one, not
whole islands (which made a sloped plate all interface, its transition one line wide where Bambu's is two).

Baseline (the build of 2026-10-30, Dense, 30 deg, own grid on): the plate starts where Bambu's does on all six but the Oblique (z0 matches; the Oblique's is 7.48 /
7.69); foot IoU 0.89 Base, 0.68 / 0.67 the Negative Spheres, 0.62 Circular, 0.68 Sphere, 0.65 Oblique (its planar slope is laid by the region plate, `regionSlopes`, as
Bambu's one ribbon, not the stair's rungs). The Circular's plate stops a layer short of Bambu's ring round the cone flank (the card's footprint ends there); the tree
matches least (IoU 0.10 - 0.18).

Update (2026-10-30, evening): a tip whose contact stands within 0.5 mm of a footprint's edge is that footprint's (`REGION_TIP_NEAR_MM`). The Oblique's strip tip lay 0.25 mm beyond
its apex, so its column was carved out of the plate and a 2 mm strip of the flat band went bare (support:reach 0 - 20 deg 73 % of Bambu's 100 %; support:coverage, support:paint
shared the cause). Oblique now vol IoU 0.74, foot 0.77, line 0.56, z0 7.69 (Bambu 7.69). Plate loops keep the ring whole where a region pinches under a line's width (Negative
Sphere2 foot 0.62 -> 0.67; Negative Sphere 0.73 -> 0.71, Circular 0.67 -> 0.66, not yet explained).

Update (2026-10-31): the region loops lie 0.12 mm in from the slab's edge (`LOOP_IN_MM`, was half a line, 0.225): on the flat-floored pieces Bambu's plate stands about 0.4 mm past ours
on both edges (Negative Sphere2 radial extent 4.6 - 6.8 against ours 5.0 - 6.4). Foot IoU Base 0.89 -> 0.91, Negative Sphere 0.71 -> 0.76, Negative Sphere2 0.67 -> 0.70, Oblique
0.77 -> 0.80; Circular 0.66 -> 0.65, Sphere 0.78 -> 0.76 (the domes' plates are not bigger in Bambu's). 0.04 mm in gave Base 0.93, Negative Spheres 0.78 / 0.74, but Sphere 0.61. Growing
the region itself (0.2 / 0.4 mm) was worse: Oblique 0.24, Negative Sphere 0.57.

Update (2026-10-31, later): the region plate's hatch lines stand 0.46 mm apart (a line and 0.04, `REGION_FILL_GAP_MM`): measured on all six pieces, Bambu's interface lines are 0.46 mm
apart on every layer (0.275 and 0.2), ours were 0.36 (the solid-infill spacing). Line length against Bambu's: Base 1.12 -> 0.94, Circular 1.14 -> 1.02, Negative Sphere 0.88 -> 0.79,
Negative Sphere2 0.79 -> 0.75, Oblique 0.98 -> 0.92, Sphere 1.51 -> 1.35. Tried and left out: growing the region 0.2 mm (new cells not taken within the clearance of the part's walls):
Circular foot 0.65 -> 0.69, Negative Sphere 0.76 -> 0.82, Sphere 0.76 -> 0.61 (its plate is already past Bambu's), moves per mm up (Base 1.1 -> 1.26, Oblique 1.3 -> 1.57).

Update (2026-10-31, transition fill): a transition region is hatched loop to loop (its ground the slab inset to the loops' own line, `LOOP_IN_MM`, not a wall's width) where the slab it lies in
is wider than 1 mm (`TRANS_FILL_OPEN_MM` 0.5 each side): the Negative Spheres' ring (1.8 - 2.3 mm), which Bambu zig-zags; a narrow ribbon (the Oblique's, under 1 mm) stays its loop alone.
Transition length (harness) Base 521 / Bambu 528, Negative Sphere 332 / 338, Negative Sphere2 240 / 304; Circular, Oblique, Sphere run high (241 / 189, 529 / 468, 154 / 110: their transition
slabs are wider than Bambu's). Line IoU Negative Sphere 0.50 -> 0.53, Negative Sphere2 0.48 -> 0.52, Circular 0.49 -> 0.51.

