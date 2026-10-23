## A raster of line art as flat printed lines (2026-09-18)
`nso_raster_lines.js` (new: the whole pipeline, browser + Node),
`tools/nso_raster_lines_cli.js` (new: raster -> STL on the command line),
`tools/nso_contact_area.js` (new: the measuring instrument),
`tools/nso_pnm.js` (new: netpbm read/write, dev tools only),
`tools/nso_raster_fixtures.js` (new: the rasters and their STLs),
`fixtures/raster-lines/` (four rasters + four STLs + `raster-lines.json`),
`docs/RASTER-LINES.md`. Checks: `npm run raster:audit`
(`tools/nso_raster_line_audit.js`, 21 checks - Task 1), `npm run raster:test`
(`tools/nso_raster_lines_test.js`, 134 checks - Tasks 2 and 3),
`npm run raster:fixtures` (byte-diff). All three are in `npm test`.

Asked for as the answer to a measured problem: the Skin patterns are RELIEF
profiles - a rib or a sawtooth ridge STANDING on a plane - and a two-layer
breakaway interface needs a real printed line's section, flat and thin.

**Task 1, the audit, and the diagnosis holds - on the zigzag.** Two copies of
the shipped loose zigzag patch, the upper turned 90 degrees across the lower and
set down on its tips, which is Bambu's two-layer construction. Measured with
`interfaceContact`, which intersects the two meshes' material regions IN the
interface plane as real 2D polygons (A's up-facing faces against B's
down-facing ones) and clusters the result into PATCHES, so a total cannot hide
whether it is isolated dots or one broad weld:

- every ridge crossing bonds over **0.42 x 1.20 mm = 0.5040 mm^2**, 195 of them,
  because a standing sawtooth is 0.42 mm at its CREST and 1.20 mm where it meets
  the plate and the upper copy presents its WIDE end to the interface. A real
  0.42 mm printed line, whose section is the same width top and bottom, bonds
  over 0.1764 mm^2. **2.857x, and the ratio IS base/tip = 1.2/0.42.**
- the whole 30 x 30 interface: **115.020 mm^2 in 197 patches**, of which two are
  the TIES, welded continuously over the full 30 mm (8.3700 mm^2 each). Against
  39.690 mm^2 in 225 isolated dots for the flat line. 2.898x.
- interface thickness **2.04 mm** against 0.60 mm for two real layers. 3.40x.
- the crossing is still **1.354x** even the WIDEST measured real line, 0.61 mm.

**The control that settles it, because "the profile is the problem" is otherwise
just a story.** Keep the path, the pitch, the 15 ridges and the 90 degree
crossing FIXED, ties off, and turn the upper copy over so a 0.42 mm crest meets
a 0.42 mm crest instead of a 1.20 mm base: **0.1764 mm^2 per crossing, to the
digit**, and 39.690 mm^2 total - the flat line's figures exactly, with the same
225 crossings. And contact scales linearly with the base width alone, tip fixed:
base 1.2 / 0.9 / 0.6 -> 0.5040 / 0.3780 / 0.2520 mm^2 per crossing, each equal
to 0.42 x base to the digit. The section is the whole variable. (Turning a patch
over is a MEASUREMENT isolating one variable, not a printable proposal, and the
audit says so where it does it.)

**And the crosshatch is a DIFFERENT fault, which the audit refuses to fold in
with it.** Its ribs are PRISMATIC - 0.42 mm top and bottom, `minWall` ==
`tipWall`, asserted - so the section is not its problem. Its problem is that ONE
layer already runs ribs BOTH ways, so a 90 degree copy's underside is the same
lattice as the tips beneath it and the two coincide instead of crossing:
**519.750 mm^2 = 100.0% of its tip area, in a SINGLE patch spanning the whole
30 x 30 footprint.** A real layer runs lines in one direction and gets its
crossing from the next layer. So the crosshatch needs a one-direction path and
the zigzag needs a flat section - which is why the importer takes the PATH from
a raster and the SECTION from two numbers.

One measurement that is NOT reusable and is worth saying so: `zigzag` with
`base` equal to `tip` is not a valid control. `zigzagPlan`'s gaps exist because
the profile falls to 0 at each ridge's edge, so at flank 0 the cells BETWEEN
ridges read `h` at both nodes and fill: 853.927 mm^2 of contact, nearly the
whole footprint. The taper is load-bearing in the plan, not only in the section.

**The measured line, and one of the two numbers is not new.** `LINE_HEIGHT` 0.3,
`LINE_WIDTH` 0.42, `LINE_WIDTH_MAX` 0.61 - tonight's Bambu values. 0.42 is also
`nso_skin.js`'s crosshatch rib, `nso_skin_patch.js`'s `MIN_WALL` and
`mesh_validate.py --min-wall`'s threshold: one extrusion line at a 0.4 nozzle.
The measured value and the repo's own figure are the same number, which is why it
is the default. Both are parameters at every entry point, and NOTHING infers a
width from the image - the raster gives the CENTRELINE, the caller gives the
section. That is the whole reason to trace rather than extrude the black pixels,
and the fixtures prove it: the same centrelines drawn with a 0.25 mm stroke and
with a 0.65 mm stroke (2.3x the ink) trace to the same 29 segments and build the
same 572 triangles.

**Task 2, and why `extrudeFlat` is a planar subdivision rather than one prism per
line.** Written literally, "extrude each traced line as a flat thin solid" is one
closed prism per polyline, and at every crossing two of them occupy the same
cubic millimetre: each prism closed, an open-edge count clean, the union
self-intersecting - the exact failure the patch work already paid for twice
(2590 and 2488 piercing pairs, both invisible to a closure check). Uniform
height is the scope, so the solid is a PRISM OVER A 2D REGION and the union is
done once, in the plane, exactly: each graph NODE gets a convex PAD (junction,
corner, or nothing for a butt cap), each EDGE a QUAD between the two pads' attach
edges, pads and quads sharing the IDENTICAL two points where they meet; top
faces at `z = height`, bottom at 0, and a wall on exactly those edges used by ONE
face. Every edge is then used by exactly two triangles - watertight by
construction with no self-intersection, the same reason `looseGrid` is. **A
4-way crossing's pad is exactly the width x width square**, which is the number
the feature exists for. Mitred to 4 half-widths (SVG's own
`stroke-miterlimit` default), bevelled beyond, so a hairpin cannot throw a spike.

Two things it can be asked to do and cannot, both measured as real intersection
AREA between the faces (so abutting reads zero and correctly passes) and both
refused by name: `tightSegments`, a segment shorter than the joins at its ends;
`overlapPairs`, two lines within a line width of each other with no node between
them - a folded hairpin, or a line ending part-way along another. From a skeleton
neither can happen; `extrudeFlat` is a public entry point, so both are checked.

**Two stages exist because of something measured, and each has its own gate.**

1. *The reduced 8-neighbourhood in `tracePaths`.* A diagonal neighbour is ignored
   when a shared 4-neighbour already connects it. Without the rule, on a
   14-pixel diagonal staircase a naive 8-neighbour count calls **12 of the 14 a
   junction** and one drawn line comes back as a pile of stubs. The test asserts
   both the one-path result AND the naive count, so the rule is visibly doing
   work rather than being asserted to.
2. *Collapsing a chamfer to its CORNER in `collapseShort`.* Zhang-Suen chamfers
   a right angle, so a traced boustrophedon corner arrives as a 0.158 mm stub at
   45 degrees which survives Douglas-Peucker because it really is that far off
   the chord - and a stub shorter than the line width cannot be drawn as a flat
   line of that width at all. The first version DROPPED one end of the stub,
   which folds the chamfer into the long line beside it and TILTS it: 0.25 mm of
   drift over a 29 mm line, half a degree, which turns a crossing from 0.176400
   into 0.176410 mm^2. Collapsing to where the two straight runs MEET leaves both
   exactly straight. Endpoints are never moved - they are the junctions other
   paths meet at.

Also pinned rather than left to be rediscovered: a W x H bar thins to a row
**W - H** long - the ends retract by half the stroke width. It is why the fat
raster traces 468.15 mm of line where the thin one traces 469.53.

**Task 3, the reference interface, and the number asked for.** The committed
`zigzag-layer.pbm` is the real two-layer zigzag's one layer at the SHIPPED
patch's own numbers - 30 x 30 mm, 15 lines, 2.0 mm pitch, centres exactly where
`ribIntervals(30, 1.2, 2.0, 0)` puts its ridges - so this measurement and the
audit's are the same measurement of the same interface, differing in the section
alone. Traced: 1 continuous boustrophedon path, 29 segments (15 lines + 14 end
turns), 0 junctions, 572 triangles, Euler 2, one component, 0 open, 0
non-manifold, 0 degenerate, 0 sliver, **0 piercing, 0 coplanar**, exactly
0.3000000 mm tall, volume == top-face area x height.

Then the same layer turned 90 degrees and set down on it: **39.6900 mm^2 of
contact in 225 patches, every one exactly 0.176400 mm^2, none spanning more than
one line width.** 225 = 15 x 15; the total is the crossings and nothing else; the
interface is 0.600 mm thick. At the widest measured line, 0.61 mm: **225 patches
of exactly 0.372100 mm^2**, 83.7226 mm^2 - still less than the relief patch's
115.020 at the NARROW line. Controls, the ones the repo's other contact checks
use: 0.05 mm apart -> two closed shells, Euler 4, 0 piercing, 0 coplanar; gap 0
-> coplanar contact on exactly 900 triangle pairs = 225 crossings x 4, which an
air gap never produces, and layer 1's top z == layer 2's bottom z bit for bit;
0.05 mm INTO -> piercing, as penetration must.

The `crosshatch` raster is the crossing case: 15 lines each way in ONE picture
trace to **225 four-way junctions**, max degree 4, one component, 5760 triangles,
**Euler -390 = genus 196 = the 14 x 14 holes in the lattice**, 0 piercing.

**A finding about the PATH, not the section, that the importer is what found.** A
boustrophedon's END TURN is a rail, and in the layer above - the same layer
turned 90 degrees - it lies PARALLEL to that layer's lines. Put it within one
line width of them and the interface bonds along the rail's whole length instead
of at a point. On the reference raster, whose traced centres sit at 1.025,
3.025, ... mm:

| end inset | 0.42 mm line | 0.61 mm line |
|---|---|---|
| 1.00 mm | rail lands ON the 1.025 line: 197 patches, 2.42 mm welds, 55.899 mm^2 | worse |
| 0.50 mm | clean (225 patches), but only because 0.5 > 0.42 | 197 patches, 2.61 mm welds, 87.984 mm^2 |
| 0.25 mm | **225 isolated crossings** | **225 isolated crossings** |

0.25 leaves 0.775 mm of clearance, more than the widest measured line, so that is
what the committed raster uses. The rule: **the end turn must clear one line
width of the layer above's outermost line.** A pattern-geometry constraint, not
an importer defect - all three rows are in part 8 of the test so it cannot be
forgotten.

**`--min-wall`, and the checker being right about the wrong question.** A traced
layer is 0.3 mm thick, so `--gate --non-solid`, which switches the wall/gap check
on at 0.42 mm, FAILS it and names the layer height as the thinnest wall. 0.42 is
the NOZZLE figure - a limit on how thin a wall can be in PLAN - and 0.3 is the
LAYER HEIGHT, printable by definition because it is exactly one layer. So a flat
line's gate is `--gate` for closure plus `--gate --non-solid --min-wall 0.3`, and
part 5 asserts BOTH directions: the 0.42 gate fails and names 0.3000 mm as the
cause, the 0.3 gate passes with 0 thin faces. All four fixtures also pass the
repo-wide `python3 tools/fixture_audit.py --gate`.

**Task 4, scope, held.** Flat line tracing only: binary or thresholded input,
uniform extrusion height. A grey picture is thresholded to ink or not-ink and
every line comes out the same height. No grayscale height-map relief mode -
that is a separate idea and nothing here starts it.

**Not wired into the UI, and that is the one thing a reader should not assume.**
This is a module plus a command-line importer; the STL it writes drops into Nest
through the ordinary file input like any other piece. There is no button, and
therefore no drive check through real Chromium - unlike Skin patch, which has
both. The next ticket is a **Trace raster** button in the Finish tab beside Skin
patch, ADDING a piece rather than replacing one, and nothing here is in its way:
`buildFromImage` already takes exactly the shape `canvas.getImageData` returns
(`{ width, height, data, channels }`, RGBA and its alpha floor handled), and
`nso_raster_lines.js` already attaches itself to `window` as a classic script -
part 9 loads it in a `vm` sandbox, builds through `window.NSO_RasterLines` there,
and feeds `buildFromImage` an RGBA `ImageData` unconverted. The module deliberately decodes no image format,
because in the browser the canvas already decodes every format the browser can
open; `tools/nso_pnm.js` exists only so the Node checks can read a real file off
disk, and is not shipped.
