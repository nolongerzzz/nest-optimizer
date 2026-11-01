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


Update (2026-10-31, the stack's gap on a slope): a column's stack top is `floor((surface - gap_at - A) / layer) - 1`, `gap_at` the perpendicular gap (`gap x sqrt(1 + slope^2)`) plus, for a bead, its downhill
edge's drop (`(half a line + 0.03) x slope`). Two changes: a footprint that is one plane leaning 3 - 70 deg (the Oblique's) has no drop to allow for - a bead stands wholly on the plane - so it takes none;
a curved face takes `REGION_BEAD_SHARE` 0.7 of it. Foot IoU Oblique 0.80 -> 0.83 (line 0.58 -> 0.64), Negative Sphere 0.76 -> 0.79, Negative Sphere2 0.70 -> 0.74, Sphere 0.76 -> 0.77, Base and Circular
unchanged. The cliff: at 0.5 or less the Circular's and Sphere's plates fail the clearance check and are not built (foot 0.28 / 0.37), so 0.7 keeps a margin (0.6 gave Circular 0.66, Sphere 0.78). With
the full allowance the Circular's plate stands a layer short of Bambu's and 0.5 mm too wide; it is still: its stack tops at 9.2 against Bambu's 9.4 and its footprint is wider than Bambu's by 0.5 - 0.8 mm
(footprint, from the beacon detector, not the loops: `LOOP_IN_MM` 0.3 - 0.7 changed nothing there). Tree IoU of the Oblique 0.12 -> 0.10 (not chased: trunks wait for the plates).

Update (2026-10-31, a curved face's taller plate): Bambu's stack on a dome stands taller and its plate narrower: its top layer is the vertical gap under the surface, and the plate keeps its distance from the part
by standing back from the face's edge. A curved face is first tried so (`REGION_TALL_TRY_MM` 0.1, then 0.2 mm in from the footprint's edge; stack heights from the vertical gap), and kept when the plate keeps its
gap (to `REGION_TALL_TOL_MM`, 0.005 mm); otherwise the face goes the way it did. The surface read of a footprint is kept (`surfCache`) so a second attempt does not cast the rays again. Circular only passes
(Circular foot 0.65 -> 0.68, vol 0.75 -> 0.79, line length 1.15 -> 1.05 of Bambu's); Sphere and the Negative Spheres come within 0.14 - 0.17 mm of the part against 0.18 and fall back. At 0.4 mm in the Circular
passes too but is too narrow (foot 0.56, length 0.76). Still short: the Circular's last layer (9.2 against 9.4) and its transition tail.

Update (2026-10-31, flat floors' loops): a region's loops lie 0.03 mm in from the slab's edge (`LOOP_IN_FLAT_MM`) on a layer whose interface+transition zones keep their area (within 3%) from the layer
below or above - a flat floor, where Bambu's plate stands 0.35 - 0.4 mm past ours - and stay 0.12 in (`LOOP_IN_MM`) on a layer that changes (a dome's rings). Foot / vol IoU Base 0.91 / 0.90 -> 0.94 / 0.93,
Negative Sphere 0.79 / 0.77 -> 0.82 / 0.83, Negative Sphere2 0.74 / 0.74 -> 0.77 / 0.79; Circular, Oblique and Sphere unchanged; line length Base 0.98, NS 0.97, NS2 0.93. Tried: -0.1 (vol Base 0.97, NS 0.88,
but foot NS2 0.67), 0.0 (foot NS 0.75), 0.06 (foot NS 0.80, vol 0.79): 0.03 is the best on both. Still short: the top layer of Oblique (2 layers), Negative Sphere(s), Circular (1 layer).

Update (2026-10-31, a ribbon's thin top): the slicer drops a layer's sheet when the slab, inset by the wall, is empty - the Oblique's top layers (its ribbon is 0.5 mm wide there, a tail of the plate under the slope) printed nothing at
12.0 where Bambu draws the ribbon's loop at 12.0 and 12.2. A slab that is one ring (no hole) of 3 mm2 or more now keeps its loops though the inset is empty (`THIN_SLAB_MIN_MM2`); a dome's thin ring (a hole) does not - the
Sphere and Negative Sphere2 gained a layer Bambu does not have when it did. Oblique foot / vol IoU 0.83 / 0.83 -> 0.84 / 0.85 (line 0.64), length 0.98 -> 1.00; the others unchanged. Still short: the Oblique's 12.2
layer (the plate generator's top band, 12.12 - 12.32, lands a layer above the slicer's last slice: sheet-grid alignment), and the Negative Spheres' / Circular's last layer.

Update (2026-10-31, tried and left out: a flat face grown outward): the flat-floored faces (Base, Negative Spheres) were tried first at 0.4 / 0.3 / 0.2 / 0.15 mm wider than the footprint (outward only, the Negative Spheres' cavity not grown into; kept
when the exact gap check holds, else the face goes as before). Base and Negative Sphere never pass the gap check (their plate would come within 0.18 of the part's wall - Bambu's does), so they stay as they were; Negative Sphere2 passes and is
worse at every size (foot 0.77 -> 0.64 at 0.4, 0.69 at 0.2, length 1.19 / 1.08 of Bambu's). So the 0.35 - 0.4 mm Bambu's flat plates stand past ours is not the footprint's edge alone; it comes with a smaller clearance from the part's
walls than ours keeps (0.18 gap + half a line). Measured since (centreline of the interface lines to the part's moves in the same layer): the Base's top layer 0.57 mm both sides, Negative Sphere 10.4 ours 0.56 / Bambu 0.59 - the wall clearance is the same, so it is not what
holds ours back. Grown again with a per-cell wall check (cells the part comes within a gap + half a line of, at the stack's middle or foot, not taken): Negative Sphere 0.25 mm foot 0.82 -> 0.79, length 1.19; Negative Sphere2
0.80 vol but foot 0.68; the Base's grown plate still meets the part (distance 0 at its stack's foot, centre of the face: not traced) at 0.4 and 0.059 mm short of the gap at 0.25. No size raises foot and volume together; left out.

Update (2026-10-31, flat floors: loops out past the edge, typed by a wider host): measured on the Negative Sphere (radii by angle) and the Base (extents along its diagonals), Bambu's loop CENTRELINES lie 0.2 - 0.25 mm past the face's
edge on a flat ring's outer side and into its hole on the inner, 0.5 at the Base's horned end - not on the edge (`LOOP_IN_FLAT_MM` 0.03 -> -0.15). Moved out alone, foot IoU fell (Negative Sphere2 0.77 -> 0.67 at -0.2) while volume rose:
the lines past the edge fell outside the part's host cut (the typing's reach), so those cells were typed TRANSITION on layers that are all interface in Bambu's (69 mm of transition line on NS2's 9.85, 28 on 10.4). On a flat floor
the host cut is now `HOST_GROW_MM` 0.2 wider, so the plate's edge stays the layer's own type. Foot / vol IoU Base 0.94 / 0.93 -> 0.98 / 0.98, Negative Sphere 0.82 / 0.83 -> 0.89 / 0.90, Negative Sphere2 0.77 / 0.79 -> 0.84 / 0.89,
line IoU +0.05 - 0.07; domes and Oblique unchanged. Applied to every layer (domes included) the wider host cost the Circular 0.68 -> 0.63 and Sphere 0.77 -> 0.72, hence flat floors only. The round blobs in Bambu's plan at the Negative Spheres'
cavity centre and rim ends (z 9.85 - 10.4) are its trunks, typed Support, not plate: they wait for the trunk work.
