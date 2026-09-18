# Raster to flat lines — a 2D picture of a toolpath becomes a printed one

`nso_raster_lines.js` turns a black-and-white raster of line art into a **flat,
thin, watertight solid** whose section is a real printed line's: 0.3 mm tall,
0.42–0.61 mm wide, the same width at its underside as at its top.

- module: `nso_raster_lines.js` (classic script → `window.NSO_RasterLines`, and
  a Node module)
- command line: `node tools/nso_raster_lines_cli.js IN.pbm OUT.stl [options]`
- audit: `npm run raster:audit` (`tools/nso_raster_line_audit.js`, 24 checks —
  the diagnosis in parts 1-4, and the crosshatch's fix measured beside it in
  part 5)
- line angle: `npm run raster:angle` (`tools/nso_line_angle.js`) — the
  orientation histogram, off the shipped mesh
- checks: `npm run raster:test` (`tools/nso_raster_lines_test.js`, 134 checks)
  and `npm run raster:fixtures` (byte-diff of `fixtures/raster-lines/`)
- all three are in `npm test`

## Why, in three numbers

The shipped Skin patterns are **relief** profiles: a rib or a sawtooth ridge
*standing* on a plane. Stack two copies of the shipped loose zigzag patch and
turn the upper one 90° across the lower, which is how Bambu builds a two-layer
interface, and measure what actually bonds:

| | shipped loose zigzag | a real flat printed line |
|---|---|---|
| contact at one crossing | **0.5040 mm²** (0.42 × 1.20) | **0.1764 mm²** (0.42 × 0.42) |
| whole 30 × 30 interface | **115.020 mm²** in 197 patches, two of them 30 mm long | **39.690 mm²** in 225 patches, none wider than one line |
| interface thickness | **2.04 mm** | **0.60 mm** |

The crossing figure is 2.857× too big, and the ratio *is* the sawtooth's
`base / tip` = 1.2 / 0.42. A standing sawtooth ridge is 0.42 mm at its crest and
1.20 mm where it meets the plate, so stacked, the upper copy presents its **wide
end** to the interface. A printed line's section is symmetric.

The control that settles it — `npm run raster:audit`, part 3 — keeps the path,
the pitch and the 90° angle *fixed* and only turns the upper copy over, so a
0.42 mm crest meets a 0.42 mm crest: **0.1764 mm² per crossing, to the digit**,
the flat line's figure exactly. Contact also scales linearly with the base
width alone (base 1.2 / 0.9 / 0.6 → 0.5040 / 0.3780 / 0.2520 mm² per crossing).
The section is the whole variable.

**The crosshatch is a different fault, and the audit keeps them apart.** Its
ribs are prismatic — 0.42 mm top and bottom — so its section is fine. Its fault
is that *one* layer already runs ribs **both** ways, so a 90° copy's underside
is the same lattice as the tips beneath it and the two coincide instead of
crossing: **519.75 mm², a single weld over the entire footprint.** A real layer
runs lines in one direction and gets its crossing from the next layer. So the
crosshatch needs a one-direction path and the zigzag needs a flat section — and
a raster of a real toolpath supplies the first while two numbers supply the
second.

That one-direction path is now built, on this module's own `extrudeFlat`:
`nso_crosshatch.js`, **110.2500 mm² in 625 isolated crossings** at the same pitch
and the same rib, against the lattice's 519.750 in one weld. Part 5 of the audit
measures the two side by side, and [docs/CROSSHATCH.md](CROSSHATCH.md) carries the
rest — including why *no* crossing angle rescues a bidirectional layer, and why
its footprint is **re-tiled** rather than scaled.

## The measured line

| | | |
|---|---|---|
| `LINE_HEIGHT` | 0.30 mm | layer height |
| `LINE_WIDTH` | 0.42 mm | extrusion width, the narrow end of the measured range |
| `LINE_WIDTH_MAX` | 0.61 mm | the wide end |

0.42 mm is not a new figure: it is `nso_skin.js`'s crosshatch rib,
`nso_skin_patch.js`'s `MIN_WALL` and the threshold `mesh_validate.py
--min-wall` carries — one extrusion line at a 0.4 mm nozzle. The measured value
and the repo's own figure are the same number, which is why it is the default.

Both are parameters everywhere. **Nothing infers a width from the image**: the
raster gives the centreline, the caller gives the section. That is the whole
reason to trace rather than to extrude the black pixels — a traced path printed
at 0.42 mm is 0.42 mm wide whatever the picture's stroke width was, and it has
no stair steps. The fixtures prove it: the same centrelines drawn with a 0.25 mm
stroke and with a 0.65 mm stroke (2.3× the ink) come back as the same 29-segment
path and the same 572-triangle solid.

## The pipeline

| stage | what it does |
|---|---|
| `toMask` | threshold to a binary ink mask. Black is ink; `invert` flips it. A browser `ImageData` is already the right shape, so the browser needs no decoder of its own. |
| `thin` | Zhang–Suen, to a one-pixel skeleton. The picture's stroke width is discarded here, on purpose. |
| `tracePaths` | the skeleton as a graph, walked into polylines. |
| `simplify` | Douglas–Peucker, which turns a staircase back into the straight line it was drawn as. |
| `collapseShort` | a chamfered corner becomes the corner it was drawn as. |
| `extrudeFlat` | the polylines as one flat solid of the given section. |

Two of those stages exist because of something measured, and both are pinned by
a check:

**The reduced 8-neighbourhood** (`tracePaths`). A diagonal neighbour is ignored
when a shared 4-neighbour already connects it. Without the rule, every step of
a diagonal staircase is a degree-3 pixel: on a 14-pixel staircase a naive
8-neighbour count calls **12 of the 14 a junction**, and one drawn line comes
back as a pile of stubs. With it, one path of 14.

**Collapsing a chamfer to its corner** (`collapseShort`). Zhang–Suen chamfers a
right angle — the skeleton of a 90° turn cuts the corner over two or three
pixels — so a traced boustrophedon corner arrives as a 0.158 mm stub at 45°,
which survives Douglas–Peucker because it really is that far off the chord. A
stub shorter than the line width cannot be drawn as a flat line of that width at
all. The first version *dropped* one end of the stub, which folds the chamfer
into the long line beside it and **tilts** it — 0.25 mm of drift over a 29 mm
line, half a degree — and half a degree of skew turns a crossing from
0.176400 mm² into 0.176410. Collapsing to where the two straight runs *meet*
leaves both exactly straight and puts the residual on the 2 mm end turn where it
belongs. Endpoints are never moved: they are the junctions other paths meet at.

One more property of thinning, pinned rather than discovered later: a W × H bar
thins to a row **W − H** long — the ends retract by half the stroke width. It is
why the fat raster traces 468.15 mm of line where the thin one traces 469.53, and
why a stroke must not be drawn so fat that a short feature vanishes into its own
end caps.

## Why `extrudeFlat` is a planar subdivision and not one prism per line

"Extrude each traced line as a flat thin solid" written literally is one closed
prism per polyline, and at every crossing two of them occupy the same cubic
millimetre. Each prism is closed, so an open-edge count sees nothing wrong — and
the union self-intersects, which is what `mesh_validate.py`'s piercing axis
exists to catch and what the skin-patch work already paid for twice (2590 and
2488 piercing pairs, both invisible to a closure check).

Every line here shares one extrusion height — uniform height is the scope — so
the solid is a **prism over a 2D region**, and the union can be done once, in
the plane, exactly:

- each graph **node** gets a convex **pad**: the junction, the corner, or
  nothing at all for a butt cap;
- each graph **edge** gets a **quad** between its two pads' attach edges;
- pads and quads share the *identical* two points where they meet, so they tile
  the region as a planar subdivision;
- top faces at `z = height`, bottom faces at `z = 0`, and a wall on exactly
  those edges used by **one** face — the region's boundary.

Every edge of the result is then used by exactly two triangles: an interior edge
by two tops and two bottoms, a boundary edge by a top, a bottom and its wall's
two. Watertight by construction and with no self-intersection, for the same
reason `nso_skin_patch.js`'s `looseGrid` is: every face between material and air
is emitted exactly once. And **a 4-way crossing's pad is exactly the
width × width square**, which is the number the whole feature is for.

A join is mitred until the mitre runs past 4 half-widths (SVG's own
`stroke-miterlimit` default), then bevelled, so a hairpin cannot throw a spike
across the piece.

Two things the construction can be asked to do and cannot. Both are **measured**
— as real intersection area between the faces, so abutting correctly reads zero
— and both are refused by name rather than silently welded:

- `tightSegments` — a segment shorter than the pads at its two ends need.
  `buildFromImage` removes these before they get here (`collapseShort`);
  `extrudeFlat`, called directly on hand-built paths, refuses and names the
  shortest.
- `overlapPairs` — two lines running within a line width of each other without
  meeting at a node: a hairpin folded back on itself, or a line ending part-way
  along another. From a skeleton this cannot happen — crossing strokes share
  pixels and become a node — but `extrudeFlat` is a public entry point.

## What comes out, measured

`fixtures/raster-lines/` carries four rasters, the STL each builds and
`raster-lines.json` with every number; `npm run raster:fixtures` byte-diffs them.

All four are drawn with their lines at **45° to the canvas edges**, which is
where a slicer prints them — see *The angle* below. The canvas is 45 mm because
the 30 mm pattern turned 45° needs 30·√2 = 42.43 mm of room.

| fixture | raster | traced | solid |
|---|---|---|---|
| `zigzag-layer` | 900² px, 1-bit, 0.25 mm stroke | 1 path, 29 segments (15 lines + 14 end turns), 0 junctions | 572 tris, Euler 2, 1 component |
| `zigzag-layer-fat` | the same centrelines, 0.65 mm stroke | 54 segments — the same line, more corner chamfer | 1072 tris |
| `zigzag-layer-aa` | 450² px, 8-bit anti-aliased | 34 segments | 672 tris |
| `crosshatch` | 900² px, 15 lines each way | 480 segments, **225 four-way junctions** | 5824 tris, **Euler −390 = genus 196** = the 14 × 14 holes |

The three zigzag variants no longer come out as the same triangle count, and
that was an artefact of the old axis-aligned drawing rather than a property
worth keeping: Zhang–Suen chamfers a *diagonal* corner more heavily the fatter
the stroke, so a fat diagonal boustrophedon keeps a few extra corner vertices.
What is invariant, and what the check now gates on, is the line itself — all
three trace **within 0.8% of the same 469 mm of line** at the same 0.42 mm
width and the same footprint to a third of a millimetre.

All four: 0 open edges, 0 non-manifold, 0 degenerate, 0 sliver, 0 inconsistent
winding, **0 piercing, 0 coplanar**, exactly 0.300 mm tall, and
volume = top-face area × height to 2e-3 (a prism, no taper anywhere). They pass
the repo-wide `python3 tools/fixture_audit.py --gate`.

### The reference interface, and the number the ticket asked for

`zigzag-layer` traced, then the same layer turned 90° and set down on it:

**39.6901 mm² of contact in 225 patches, every one exactly 0.176400 mm², none
spanning more than one crossing square's diagonal.** 225 = 15 lines crossed by
15. The total is the crossings and nothing else. The interface is 0.600 mm thick.

At the widest measured line, 0.61 mm: **225 patches of exactly 0.372100 mm²**,
83.7225 mm² — still less than the relief patch's 115.020 mm² at the *narrow*
line.

A crossing patch's *bounding box* spans w·√2 rather than w, because at 45° the
w × w square is itself turned 45° and the box catches its diagonal: 0.5943 mm
measured against 0.5940 predicted. That √2 is one of four places the
orientation shows up in the numbers.

The controls are the ones the repo's other contact checks use. 0.05 mm apart:
two closed shells, Euler 4, 0 piercing, 0 coplanar. At gap 0: coplanar contact
on exactly 900 triangle pairs = 225 crossings × 4, which an air gap never
produces, and layer 1's top z equals layer 2's bottom z bit for bit. 0.05 mm
*into* the layer below: piercing, as penetration must.

### The angle — the bug the rest of the suite could not see

A slicer prints an interface layer at **45° to the part's axes**, and the next
layer at 135°, which is where the 90° between them comes from. The first
committed reference here was drawn **axis-aligned** — vertical lines joined by
horizontal turns — and *every other number in this document still held*, because
every one of them is angle-blind: the section, the closure, the contact per
crossing and the patch count are all invariant under a rigid turn. Two layers
90° apart cross at 90° whatever absolute angle they sit at. Nothing looked, so
nothing caught it.

Measured with `npm run raster:angle` on the old fixture and the new one — the
histogram of the shipped mesh's vertical wall directions, weighted by length:

| | dominant band | 45°±1 | 90°±1 | 0°±1 |
|---|---|---|---|---|
| old, axis-aligned | **89°±1 at 94.03%** | **0.00%** | 94.03% | 3.85% |
| now | **45°±1 at 93.99%** | **93.99%** | **0.00%** | **0.00%** |

The remaining 6.01% is the end turns, which are perpendicular to the lines by
construction and therefore land at 135°; the two families together are 100.00%
of the wall length. The `crosshatch` fixture, which has two line families rather
than one, reads 48.87% at 45° and 49.52% at 135°, and 0.00% at both axes.

**The fix is a rigid turn of the whole pattern, not a redraw.** The path shapes
are still laid out in the pattern's own 30 × 30 frame exactly as before, and
`turned()` maps that frame into the canvas at `ANGLE`. Rigid is the point: layer
2 is still layer 1 turned 90°, so the two-layer assembly is the old assembly
turned 45° as a whole, and every contact figure is therefore expected to be
*identical* rather than merely similar. The check asserts that equality instead
of assuming it — 39.6900 mm² before, 39.6901 after, 225 patches of exactly
0.176400 mm² either way — which is a stronger statement about the geometry than
the old fixture could make.

`ANGLE` names **the angle the lines run at**, not the rotation applied, because
the first attempt at this fix rotated by +45° from vertical and put the lines at
135° and the turns at 45° — the right diagonal, the wrong one of the two.

The orientation now has four independent gates, so it cannot drift back:

1. the wall-direction histogram above, on the shipped mesh;
2. the same histogram on the tracer's own paths, which must agree with it;
3. the solid's bounding box, which is **square** — a W × H rectangle turned 45°
   has a bbox of (W+H)/√2 in *both* axes, and that holds at 45° and at no other
   angle (40.947 × 41.191 mm measured, 41.253 predicted);
4. the crossing patch's bbox spanning w·√2 rather than w.

### Two tracer fixes the angle change uncovered

Neither was reachable with axis-aligned input, and both are real:

**Junction clusters at diagonal crossings** (`weldNodes`). A right-angled X
thins to one clean degree-4 pixel; a **45° X does not** — Zhang–Suen leaves a
little cluster of Y-junctions joined by one-pixel bridges. Measured on the 45°
crosshatch: **960 graph nodes where a clean lattice has 225 junctions and 60
line ends, 900 traced paths shorter than 0.1 mm, closest node pair exactly one
pixel apart.** `extrudeFlat` refused the lot, correctly — a 0.05 mm segment
cannot carry a 0.42 mm line's joins. `collapseShort` could not help: it fixes a
short segment *inside* a polyline, where one end is a free vertex it may move,
and here **both** ends are junctions. So the graph-level pass clusters endpoints
within one line width, moves each to its cluster's centroid, and drops what
collapses. The four arms of a crossing then meet at one point and the junction
is the degree-4 node it always was: 480 segments, **225 junctions**, one
component.

**Slivers at welded junctions** (the pad's attach corners). A welded junction's
arms are a fraction of a degree off perpendicular, so the pad's wedge point no
longer lands exactly *on* its attach point the way it does at a true right
angle — it lands a few microns away and leaves a sliver: **776 triangles over
aspect 100, the worst a 0.0037 mm edge against a 0.30 mm one.** Two changes fix
it. A wedge point within 2% of a line width of the corner beside it is dropped
(it is the pad's own vertex and nothing else references it). And where edge *i*'s
left corner and edge *i+1*'s right corner are the same corner of the junction,
they are **merged to their midpoint on the `inc` entries that both the pad and
the quads read their corners from** — so one corner serves two quads, and
watertightness survives because there is still exactly one point. Result: **0
slivers on all four fixtures, worst aspect on the crosshatch down from 115 to
16**, with Euler, closure and piercing unchanged.

### One finding about the path, not the section

A boustrophedon's **end turn is a rail**, and in the layer above — which is this
layer turned 90° — it lies *parallel* to that layer's lines. Put it within one
line width of them and the interface bonds along the rail's whole length instead
of at a point. Measured on the reference raster, whose traced line centres sit at
1.025, 3.025, … mm:

| end inset | at a 0.42 mm line | at a 0.61 mm line |
|---|---|---|
| 1.00 mm | the rail lands **on** the 1.025 line: 197 patches, welds 2.42 mm long, **55.899 mm²** | worse |
| 0.50 mm | clean — 225 patches — but only because 0.5 > 0.42 | 197 patches, 2.61 mm welds, **87.984 mm²** |
| **0.25 mm** | **225 isolated crossings** | **225 isolated crossings** |

0.25 mm leaves 0.775 mm of clearance, more than the widest measured line, so the
committed raster uses it. As a rule: **the end turn must clear one line width of
the layer above's outermost line.** This is a pattern-geometry constraint, not an
importer defect — but the importer is what measured it.

### A note on `--min-wall`

A traced layer is **0.3 mm thick**, so `mesh_validate.py --gate --non-solid`,
which switches the wall/gap check on at 0.42 mm, fails it and names the layer
height as the thinnest wall. That is the checker being right about the wrong
question: 0.42 mm is the **nozzle** figure — one extrusion line, a limit on how
thin a *wall* can be in plan — and 0.3 mm is the **layer height**, which is by
definition printable because it is exactly one layer. So a flat line's own gate
is `--gate` for closure plus `--gate --non-solid --min-wall 0.3`, and both are
asserted, in both directions, in part 5 of the check.

## Command line

```
node tools/nso_raster_lines_cli.js IN.(pbm|pgm|ppm) OUT.stl [options]

  --width MM        printed line width      (default 0.42; measured range → 0.61)
  --height MM       printed line height     (default 0.3)
  --mm-per-px X     scale                   (default 0.1)
  --size MM         instead of --mm-per-px: the raster's pixel width becomes this
  --threshold N     0..255, ink BELOW it    (default 128)
  --invert          ink is the light side instead
  --simplify PX     Douglas-Peucker tolerance, pixels (default 1.0)
  --min-segment MM  shortest segment kept   (default = the line width)
  --base-z MM       where the underside sits (default 0)
  --layers N        stack N copies, each turned 90° from the one below (default 1)
  --json            the report as JSON
```

```
$ node tools/nso_raster_lines_cli.js fixtures/raster-lines/zigzag-layer.pbm \
      interface.stl --size 30 --layers 2
```

`--layers 2` writes the two-layer interface as **two closed shells touching at
z = 0.3** — 0 open edges, 0 non-manifold, Euler 4. That is what two stacked
pieces are; the coplanar pairs the checker then reports are the contact, and the
0.05 mm controls above are what separate contact from penetration.

Image decoding is netpbm only, because the module decodes nothing: in the browser
a canvas hands it an `ImageData` for every format the browser can open. To bring
a PNG or JPEG through the command line, convert it first.

## Scope, explicitly

**Flat line tracing only** — binary or thresholded input, uniform extrusion
height. There is no grayscale height-map relief mode: a grey picture is
thresholded to ink or not-ink and every line comes out the same height. That is
a separate idea and is not started here.

Also not done, and deliberately: **this is not wired into the app's UI.** It is a
module plus a command-line importer, and the STL it writes drops into Nest
through the ordinary file input like any other. A **Trace raster** button in the
Finish tab — next to Skin patch, adding a piece rather than replacing one, with
`ImageData` from a canvas and a drive check through real Chromium — is the
obvious next ticket and nothing here is in its way, and part 9 of the check
proves it: the module is loaded in a `vm` sandbox, built through
`window.NSO_RasterLines`, and handed an RGBA `ImageData` unconverted.
