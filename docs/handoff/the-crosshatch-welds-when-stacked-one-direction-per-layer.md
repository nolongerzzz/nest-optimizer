## The crosshatch welds when stacked - one direction per layer (2026-09-18, same day)
`nso_crosshatch.js` (new), `tools/nso_crosshatch_test.js` (new, 56 checks),
`tools/nso_crosshatch_fixtures.js` (new), `fixtures/crosshatch/` (new),
`docs/CROSSHATCH.md` (new), `tools/nso_raster_line_audit.js` (part 5, now 24
checks), `nso_skin.js` (the PATTERNS note - comment only), `README.md`,
`docs/RASTER-LINES.md`, `fixtures/README.md`. Checks: `npm run crosshatch:test`,
`npm run crosshatch:fixtures`, both in `npm test`.

**THE DEFECT, AND THAT NO ANGLE FIXES IT.** The raster-line audit had already
measured it and refused to fold it in with the zigzag's: the shipped
`crosshatch` runs ribs BOTH ways in ONE layer, so a 90 degree copy's underside is
the same lattice as the tips beneath it and **519.750 mm^2 - 100.0% of the tip
area - welds in a single patch spanning the whole 30 x 30 footprint.** What is
new here is the rest of the sweep, because "turn it further" is the obvious first
idea and it does not work:

| upper copy turned | contact | patches | widest patch |
|---|---|---|---|
| 15 deg | 272.426 mm^2 | 137 | 4.92 mm |
| 30 deg | 252.714 | 138 | 6.42 mm |
| 45 deg | 248.124 | 146 | **30.00 mm** |
| 60 deg | 252.714 | 138 | 6.42 mm |
| 90 deg | **519.750** | **1** | 30.00 mm |

A rotation by 90 maps a square lattice onto itself, and every other angle leaves
two lattices crossing along LINES rather than at points. The best of them still
bonds 248 mm^2 in patches millimetres long. There is no angle; the construction
is the fault. The SECTION is not - the rib is prismatic, 0.42 top and bottom,
`minWall == tipWall`, asserted.

**THE FIX** is the raster tracer's own two-layer reference, generalised: one
direction per layer, two layers, the second crossing the first, built on
`NSO_RasterLines.extrudeFlat` unchanged (the planar subdivision, so a four-way
crossing's pad is exactly the width x width square). Same pitch, same rib, same
height, same footprint, same instrument - the two rows differ in the
CONSTRUCTION alone:

    ribs both ways, ONE layer    519.750 mm^2 in   1 patch,  widest 30.00 mm
    one direction, TWO layers    110.250 mm^2 in 625 patches, widest 0.5940 mm

625 = 25 lines crossed by 25, every patch exactly **0.176400 mm^2 = width x
width**, none spanning more than w*sqrt2 = 0.5940 (the crossing square turned 45
and its box catching the diagonal). The total is predicted from the plan
(`repeats^2 * width^2`) before anything is built and then measured.

**THE GUARD, so it cannot come back quietly.** `directionCensus` histograms a
layer's segment directions BY LENGTH; `oneDirection` refuses a layer whose second
family carries more than 25% of it; `build` runs it on both layers before any
geometry exists. The defect's own centrelines read **50 / 50** and are refused by
name, with the 519.750 in the refusal text. A real layer reads 96.30 / 3.70 (the
3.70 is its end turns). One trap stated outright rather than left to be
rediscovered: measured on the PAIR, the fixed interface also reads 50/50 at 45
and 135, exactly like one bidirectional layer - the histogram only means
something PER LAYER, and both readings are asserted.

**THE END TURN, measured by building the weld it prevents.** A boustrophedon's
turn runs across its own layer's lines, so in the layer above it lies PARALLEL to
that layer's lines (the finding the raster work already paid for). Half a pitch
puts it in the middle of the other layer's channel. `turnOffset` is a parameter
so the rule is measured, not asserted:

| offset | clearance | patches | contact | widest |
|---|---|---|---|---|
| 0.60 (pitch/2) | +0.18 | **625** | 110.2500 | **0.594 mm** |
| 0.42 (one line) | 0.00 | 597 | 110.2500 | 2.291 mm |
| 0.30 | -0.12 | 577 | 114.7429 | 2.291 mm |

At exactly one line width the AREA does not move at all - abutting strips
intersect in nothing - but the patches MERGE, 597 instead of 625 with welds 3.9
crossing squares long. That is the case a total hides and the patch clustering
catches. So `plan` REFUSES a pitch whose half does not clear the line, by name
and with the number: width 0.61 at pitch 1.2 (clearance -0.01) and
`crosshatch-fine`'s 0.84 at width 0.42 (clearance 0.00) are both refused, and the
refusal names both ways out. `ends: 'open'` is one of them - separate lines, no
turns, several components REPORTED rather than hidden (the call
`nso_skin_patch.js` already makes for `ties: 0`), and the contact is identical
either way, which is the proof the turns touch nothing.

**RE-TILING, NOT SCALING (the second half of the ticket).** `c_k = width/2 +
turnOffset + k*pitch` does not depend on `repeats`, so re-tiling APPENDS lines
and never moves one: all 16 centres of a 19.62 mm pattern are bit-identical in
the 44.82 mm one, with pitch, width, height and channel bit-identical too. The
price is a quantised span - `fitRepeats` reports the residual rather than
absorbing it (30 mm asked -> 25 repeats, 30.42 mm, +0.42 residual; modes
nearest / down / up). The control is the design pattern this replaces: the same
20 mm build SCALED by 2.2844 to reach the same span gives line 0.42 -> **0.9594**,
channel 0.78 -> **1.7818**, height 0.60 -> **1.3706**, crossing 0.176400 ->
**0.920543 mm^2**. Every figure the pattern is made of, at once.

**AND WHETHER THE RASTER PATH WOULD HAVE BEEN SIMPLER - measured, since the
ticket asked.** This module's own paths stroked into a canvas sized for the
pattern, thresholded, thinned, traced back and built at the same fixed width:
20 mm target -> 31 segments / 612 tris traced against 31 / 612 laid out directly,
line length 324.80 vs 325.20 (0.12%); 30 mm -> 49 / 972 either way, 778.76 vs
778.80 (0.005%). So the raster path WOULD re-tile correctly - it is the longer
way round to a path three numbers give exactly, and it adds Zhang-Suen's chamfers
and junction clusters to a layout that has neither. The parametric layout ships;
the round trip stays in the test as the check that the two agree.

**CANONICAL CHECKER.** One layer: 0 open, 0 non-manifold, 0 degenerate, 0 sliver,
0 winding, **0 piercing, 0 coplanar**, Euler 2, `--gate` PASS. The stack: two
closed shells, Euler 4, 0 open, and at gap 0 exactly **4 coplanar + 8 piercing
pairs PER CROSSING** - the same per-crossing signature the raster reference gives
(225 crossings -> 900 / 1800), so it scales with the crossings and is the contact,
not penetration; gated as that exact multiple. Controls: 0.05 apart -> 0 / 0;
0.05 INTO -> 8300 piercing. `--gate --non-solid` at 0.42 fails and names the
0.3 mm LAYER HEIGHT, and passes at `--min-wall 0.3`, both directions asserted -
the same reading as a traced flat line.

**SCOPE.** Geometry only, NOT wired into the UI - the raster importer's scope
line. The shipped `crosshatch` relief is UNCHANGED and stays what it is: correct
against a flat mating face, where `tipContactArea` is the right instrument and
the tip area IS the contact. Its PATTERNS entry now says in the file what it is
not, and points here.
