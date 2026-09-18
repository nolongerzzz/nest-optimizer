# The crosshatch, as two one-direction layers

`nso_crosshatch.js` builds a crosshatch breakaway interface the way a printer
builds one: **one direction of lines per layer, two layers, the second crossing
the first**. It replaces the one thing the shipped `crosshatch` relief cannot do
— be *stacked* — and it keeps everything else about that pattern, including its
numbers.

- module: `nso_crosshatch.js` (classic script → `window.NSO_Crosshatch`, and a
  Node module)
- checks: `npm run crosshatch:test` (`tools/nso_crosshatch_test.js`, 56 checks)
  and `npm run crosshatch:fixtures` (byte-diff of `fixtures/crosshatch/`)
- the diagnosis it answers: `npm run raster:audit`, parts 4 and 5
- both are in `npm test`

## The defect, in one number, and why turning it further does not help

Stack two copies of the shipped loose crosshatch patch and turn the upper one
across the lower — Bambu's two-layer construction — and measure what actually
bonds (`tools/nso_contact_area.js`, real 2D polygon intersection in the interface
plane, clustered into patches so a total cannot hide a weld):

| upper copy turned by | contact | patches | widest patch |
|---|---|---|---|
| 15° | 272.426 mm² | 137 | 4.92 mm |
| 30° | 252.714 mm² | 138 | 6.42 mm |
| 45° | 248.124 mm² | 146 | **30.00 mm** |
| 60° | 252.714 mm² | 138 | 6.42 mm |
| **90°** | **519.750 mm²** | **1** | **30.00 mm** |

At 90° the contact is **100.0% of the tip area in a single patch spanning the
entire 30 × 30 footprint** — the whole tip area, welded. And the rest of the
sweep is the part worth keeping: *there is no angle that fixes it.* A rotation by
90° maps a square lattice onto itself, and every other angle leaves two lattices
crossing each other along lines rather than at points — the best of them still
bonds 248 mm² in patches millimetres long.

The section is not the fault: a crosshatch rib is prismatic, 0.42 mm at the top
and 0.42 at the bottom (`minWall == tipWall`, asserted). The fault is that **one
layer already runs ribs both ways**. A printed layer runs lines in *one*
direction and gets its crossing from the *next* layer.

## The fix, measured with the same instrument

Same pitch (1.2 mm), same rib (0.42 mm), same 30 mm target, and the same overall
height — the relief's 0.6 mm, read as what it always stood in for: **two real
0.3 mm layers**. So the two rows differ in the **construction alone**:

| | contact | patches | widest patch |
|---|---|---|---|
| ribs both ways, ONE layer | 519.750 mm² | **1** | 30.00 mm |
| one direction, TWO layers | **110.2500 mm²** | **625** | **0.5940 mm** |

625 = 25 lines crossed by 25. Every patch is **exactly 0.176400 mm² = width ×
width**, the flat printed line's own crossing figure, and no patch spans more
than `w·√2` = 0.5940 mm — one crossing square's diagonal, because at 45° the
square is itself turned 45° and its axis-aligned box catches the diagonal. The
total is the crossings and nothing else, and it is predicted from the plan
(`repeats² × width²`) before anything is built.

4.71× less bonding, and — the part that matters for breakaway — **625 isolated
dots instead of one 30 mm weld**.

The lines are built by `NSO_RasterLines.extrudeFlat`, unchanged: the planar
subdivision that gives a real printed line's section and makes a four-way
crossing's pad exactly the width × width square. `docs/RASTER-LINES.md` carries
why that is a planar subdivision and not one prism per line.

## The guard, so the defect cannot come back quietly

`directionCensus(paths)` histograms a layer's segment directions by **length**,
and `oneDirection(paths)` refuses a layer whose second family carries more than
25% of it. `build()` runs it on both layers before it builds anything.

| layer | dominant | across it | oblique |
|---|---|---|---|
| the defect (ribs both ways) | 50.00% at 45° | **50.00%** | 0% |
| layer 1 | 96.30% at 45° | 3.70% (the end turns) | 0% |
| layer 2 | 96.30% at 135° | 3.70% | 0% |

The refusal names the number it is protecting: *"a 90 degree copy maps the
lattice onto itself and the interface welds over its whole footprint (measured:
519.750 mm² in ONE patch)"*.

One trap the check states outright: measured on the **pair**, the fixed
interface also reads 50/50 at 45° and 135°, exactly like one bidirectional
layer. The orientation histogram only means something **per layer**, and the
check asserts both readings so the distinction cannot be lost.

## The layout

```
line centres   c_k = width/2 + turnOffset + k * pitch,  k = 0 .. repeats-1
end turns      at width/2 and span - width/2
span           (repeats - 1) * pitch + 2 * turnOffset + width
               = repeats * pitch + width   at the default turnOffset = pitch/2
```

One layer is a **boustrophedon**: up the first line, across to the second, down
it, and so on. One continuous path, which is what a slicer emits and what makes
a layer one component. `ends: 'open'` leaves the lines separate instead — several
components, **reported** rather than hidden, the same call `nso_skin_patch.js`
makes for a zigzag patch with `ties: 0`. Measured: the contact is identical
either way (110.2500 mm² in 625 patches), because the turns are placed where
they touch nothing.

### The end turn's offset is half a pitch, and that is a measurement

A boustrophedon's turn runs *across* its own layer's lines, so in the layer
above it lies **parallel** to that layer's lines. Half a pitch puts it in the
middle of the channel the other layer leaves. `turnOffset` is a parameter so the
rule can be measured rather than asserted — holding everything else fixed:

| turn offset | clearance | patches | contact | widest patch |
|---|---|---|---|---|
| **0.60 mm** (= pitch/2) | +0.18 mm | **625** | 110.2500 mm² | **0.594 mm** |
| 0.42 mm (= one line width) | 0.00 mm | 597 | 110.2500 mm² | 2.291 mm |
| 0.30 mm | −0.12 mm | 577 | 114.7429 mm² | 2.291 mm |

At exactly one line width the *area* has not moved at all — abutting strips
intersect in nothing — but the patches have **merged**: 597 instead of 625, with
welds 2.29 mm long, four crossing squares end to end. That is precisely the case
a total would hide and the patch clustering exists to catch. Below it, the area
grows too.

So `plan` **refuses** a pitch whose half does not clear the line, by name and
with the number:

- `width 0.61` at pitch 1.2 → clearance −0.01 mm, refused
- `crosshatch-fine`'s pitch 0.84 at width 0.42 → clearance 0.00 mm, refused

and it names both ways out: raise the pitch above `2 × width`, or use
`ends: 'open'`.

## The angle

`angle` names **the angle layer 1's lines run at**, not the rotation applied —
the same convention and the same reason as `tools/nso_raster_fixtures.js`'s
`ANGLE`. The pattern is laid out in its own span × span frame and turned rigidly
as a whole, so every contact figure is *invariant*, and the check asserts that
equality instead of assuming it:

| | contact | patches | widest patch |
|---|---|---|---|
| axis-aligned (`angle: 90`) | 110.250038 mm² | 625 | 0.4200 mm = `w` |
| at 45° (the default) | 110.249955 mm² | 625 | 0.5940 mm = `w·√2` |

Only the patch's *box* turns. Laid out axis-aligned the footprint is exactly the
span the plan claims — 30.4200 × 30.4200 mm — which is the gate on the layout
arithmetic itself.

## Re-tiling: resizing without touching the pattern

**A crosshatch is not resized by scaling it.** Scaling moves every figure the
pattern is made of at once. The same 20 mm build scaled by 2.2844 to reach a
44.82 mm span:

| | asked for | after the scale |
|---|---|---|
| line width | 0.42 mm | **0.9594 mm** |
| open channel | 0.78 mm | **1.7818 mm** |
| interface height | 0.60 mm | **1.3706 mm** |
| contact per crossing | 0.176400 mm² | **0.920543 mm²** (5.22×) |

Re-tiling changes the one thing that should change — **the number of whole
repeats** — and nothing else:

```
C.retile({ W: 20, D: 20 }, { W: 45, D: 45 })
```

| | 20 mm target | 45 mm target |
|---|---|---|
| repeats | 16 | **37** |
| span | 19.62 mm | 44.82 mm |
| pitch / width / channel | 1.2 / 0.42 / 0.78 | **the same three numbers, bit for bit** |
| crossings | 256 | 1369, every one still 0.176400 mm² |

`c_k = width/2 + turnOffset + k·pitch` **does not depend on `repeats`**, so
re-tiling *appends* lines: all 16 of the small pattern's centres are in the same
place in the large one, bit for bit — which a scale could not be, and which the
check asserts directly.

The price is that the span is **quantised**, and `fitRepeats` reports the
residual rather than absorbing it by stretching anything:

| target | repeats | span | residual |
|---|---|---|---|
| 10 mm | 8 | 10.02 mm | +0.020 |
| 20 mm | 16 | 19.62 mm | −0.380 |
| 30 mm | 25 | 30.42 mm | +0.420 |
| 45 mm | 37 | 44.82 mm | −0.180 |
| 60 mm | 50 | 60.42 mm | +0.420 |

`mode` is `'nearest'` (default), `'down'` or `'up'`.

### Would re-tracing a differently-sized canvas have been simpler?

The ticket asked, so it was measured rather than argued. This module's own paths
are stroked into a canvas sized for the pattern, thresholded, thinned, traced
back by `NSO_RasterLines.buildFromImage` and built at the same fixed line width:

| target | canvas | traced | laid out directly |
|---|---|---|---|
| 20 mm | 28 mm at 20 px/mm (560 px) | 31 segments, 612 tris, 324.80 mm of line | 31, 612, 325.20 mm |
| 30 mm | 44 mm at 20 px/mm (880 px) | 49 segments, 972 tris, 778.76 mm | 49, 972, 778.80 mm |

Segment for segment and triangle for triangle, at the same 0.42 mm width, with
the line length agreeing to 0.12% and 0.005% (the raster suite holds three
different strokes of one drawing to 0.8%). So **the raster path would re-tile
correctly** — it is simply the longer way round to a path that three numbers
already give exactly, and it adds Zhang–Suen's chamfers and junction clusters to
a layout that has neither. The parametric layout ships; the round trip stays as
a check that the two agree.

## What ships, measured

`fixtures/crosshatch/` carries four STLs and `crosshatch.json` with every number;
`npm run crosshatch:fixtures` byte-diffs them.

| file | what it is |
|---|---|
| `layer1.stl` / `layer2.stl` | one printed layer on its own — 972 tris, closed, Euler 2 |
| `interface.stl` | the two of them, 30 mm target — 1944 tris, 2 shells, Euler 4 |
| `interface-45.stl` | **the re-tile**: the same pitch, width and channel at a 45 mm target — 2904 tris |

Through the canonical checker (`tools/mesh_validate.py`):

- **one layer**: 0 open, 0 non-manifold, 0 degenerate, 0 sliver, 0 inconsistent
  winding, **0 piercing, 0 coplanar**, Euler 2, `--gate` PASS.
- **the stack**: two closed shells, Euler 4, 0 open. At gap 0 the checker reports
  exactly **4 coplanar and 8 piercing pairs per crossing** — the same
  per-crossing signature the raster reference gives (225 crossings → 900 / 1800),
  so it scales with the crossings and is the *contact*, not penetration. The
  repo's own controls separate them: 0.05 mm apart → 0 piercing and 0 coplanar;
  0.05 mm *into* → 8300 piercing.
- `--gate --non-solid` at 0.42 mm fails and names the **0.3 mm layer height** as
  the thinnest wall — the checker being right about the wrong question, exactly
  as for a traced flat line. The gate for this piece is `--gate` plus
  `--gate --non-solid --min-wall 0.3`, and both are asserted in both directions.

## Scope, explicitly

Geometry only, and **not wired into the app's UI** — the same scope line the
raster importer ships under. The shipped `crosshatch` relief in `nso_skin.js` is
unchanged and stays exactly what it is: the right shape for a relief standing on
a face whose mating piece is a flat plate, where `NSO_Skin.tipContactArea` is the
correct instrument and the tip area *is* the contact. What it is not is a layer
you can stack another patterned layer on, and that is what this module is for.
