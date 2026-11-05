## The reference raster was drawn at the wrong ANGLE (2026-09-18, same day)
`tools/nso_raster_fixtures.js` (ANGLE / TURN / CANVAS and `turned`),
`tools/nso_line_angle.js` (new: the instrument), `nso_raster_lines.js`
(`weldNodes`, and the pad now OWNS its attach corners), `fixtures/raster-lines/`
(all four regenerated), `docs/RASTER-LINES.md`. Check: `npm run raster:angle`,
plus four gates inside `npm run raster:test` (now 134 checks).

**The bug, and why nothing caught it.** A slicer prints an interface layer at 45
degrees to the part's axes and the next at 135, which is where the 90 between
them comes from. The reference raster committed with the feature was drawn
AXIS-ALIGNED - vertical lines joined by horizontal turns - and **every other
number in the suite still held**, because every one of them is angle-blind: the
section, the closure, the contact per crossing, the patch count are all
invariant under a rigid turn, and two layers 90 degrees apart cross at 90
degrees whatever absolute angle they sit at. Nothing measured the orientation,
so nothing saw it. Measured now, with the instrument that was missing:

| | dominant band | 45 +/-1 | 90 +/-1 | 0 +/-1 |
|---|---|---|---|---|
| as committed | **89 +/-1 at 94.03%** | **0.00%** | 94.03% | 3.85% |
| now | **45 +/-1 at 93.99%** | **93.99%** | **0.00%** | **0.00%** |

The remaining 6.01% is the end turns, perpendicular to the lines by
construction and therefore at 135; the two families are 100.00% of the wall
length. The crosshatch, having two line families, reads 48.87% at 45 and 49.52%
at 135, and 0.00% at both axes.

**The instrument** (`tools/nso_line_angle.js`) histograms the SHIPPED MESH's
vertical-wall edge directions into 1-degree bins, weighted by horizontal length,
undirected. A line of length L and width w contributes 2L at its own angle and
2w of cap at 90 degrees to it, so a long thin line's own angle dominates its own
weight - which is what makes the share meaningful rather than a triangle count.
It also histograms the tracer's own paths, and the check requires the two to
agree, because the mesh is what ships and the path is only what the tracer
believes. One reporting subtlety worth knowing: a +/-1 band is a window, so
neighbouring centres TIE whenever the weight sits in one bin (44 +/-1 and 45
+/-1 both cover bin 45), and the tie is broken on the centre bin's own weight -
without that a family genuinely at 45 reports as 44.

**The fix is a RIGID TURN of the whole pattern, not a redraw.** The path shapes
are still laid out in the pattern's own 30 x 30 frame exactly as before and
`turned` maps that frame into the canvas at ANGLE. Rigid is the point: layer 2
is still layer 1 turned 90 degrees, so the two-layer assembly is the OLD
assembly turned 45 degrees as a whole, and every contact figure is therefore
expected to be IDENTICAL rather than merely similar. The check asserts that
equality instead of assuming it - **39.6900 mm^2 before, 39.6901 after, 225
patches of exactly 0.176400 mm^2 either way**, and 83.7226 -> 83.7225 at the
0.61 mm line. The inset finding reproduces too (inset 1.00 -> 197 patches with
2.02 mm welds, 57.064 mm^2; inset 0.25 clean at both widths).

`ANGLE` names **the angle the lines run at**, not the rotation applied. The
first attempt rotated by +45 from vertical and put the lines at 135 and the
turns at 45 - the right diagonal, the wrong one of the two - so the constant
names the measured quantity and `TURN = ANGLE - 90` is derived. `CANVAS` is
derived from both, because a 30 mm pattern turned 45 degrees needs 30 * sqrt(2)
= 42.43 mm of room: 45 mm at 20 px/mm, so the rasters are 900 px square.

**Four independent gates, so it cannot drift back:** the wall histogram on the
mesh; the same histogram on the tracer's paths, which must agree; the solid's
bounding box being SQUARE, since a W x H rectangle turned 45 degrees has a bbox
of (W+H)/sqrt(2) in BOTH axes and that holds at 45 and at no other angle
(40.947 x 41.191 measured, 41.253 predicted); and a crossing patch's bbox
spanning w * sqrt(2) = 0.5940 rather than w, because the w x w square is itself
turned (0.5943 measured).

**Two tracer faults the angle change uncovered, neither reachable with
axis-aligned input.**

1. *Junction clusters at diagonal crossings.* A right-angled X thins to one
   clean degree-4 pixel; a 45 degree X does NOT - Zhang-Suen leaves a cluster of
   Y-junctions joined by one-pixel bridges. Measured on the 45 degree
   crosshatch: **960 graph nodes where a clean lattice has 225 junctions and 60
   line ends, 900 traced paths shorter than 0.1 mm, closest node pair exactly
   one pixel apart**, and `extrudeFlat` refused the lot - correctly, a 0.05 mm
   segment cannot carry a 0.42 mm line's joins. `collapseShort` could not help:
   it fixes a short segment INSIDE a polyline, where one end is a free vertex it
   may move, and here BOTH ends are junctions. New `weldNodes` clusters
   endpoints within one line width, moves each to its cluster's centroid and
   drops what collapses, iterated with a guard. The four arms then meet at one
   point: 480 segments, **225 junctions**, one component, Euler -390 = genus 196
   preserved.
2. *Slivers at welded junctions.* A welded junction's arms are a fraction of a
   degree off perpendicular, so the pad's wedge point no longer lands exactly ON
   its attach point the way it does at a true right angle - it lands microns
   away and leaves a sliver: **776 triangles over aspect 100, the worst a 0.0037
   mm edge against a 0.30 mm one.** Two changes, and the second is the
   structural one. A wedge point within 2% of a line width of the corner beside
   it is dropped, which is safe because it is the pad's OWN vertex and nothing
   else references it - that halved the count. The rest were between two SHARED
   corners, which cannot be dropped, so the pad now **owns its attach corners**:
   they are computed once onto the `inc` entry and the quads read them from
   there instead of recomputing the same formula, which lets edge i's left
   corner and edge i+1's right corner be MERGED to their midpoint with the quads
   following for free. One corner, two quads, watertight by the same argument as
   before because there is still exactly one point. **0 slivers on all four
   fixtures, worst aspect on the crosshatch 115 -> 16**, closure, Euler and
   piercing unchanged.

**One number that legitimately stopped holding, and is not papered over.** The
three zigzag rasters no longer come out as the same 572 triangles. That equality
was an artefact of axis-alignment: Zhang-Suen chamfers a DIAGONAL corner more
heavily the fatter the stroke, so a fat diagonal boustrophedon keeps a few extra
corner vertices (29 / 54 / 34 segments). The claim the fixture set exists to
make - that the picture's stroke width never reaches the SECTION - is now gated
on what actually carries it: the same 0.42 mm width, the same line length to
0.8%, and the same footprint to a third of a millimetre. The anti-aliased
fringe's size moved for the same reason (1.91x the core then, 1.33x now, a 3 px
stroke at 10 px/mm having less core against its ramp), so that gate asks for a
substantial grey band rather than a pinned ratio.
