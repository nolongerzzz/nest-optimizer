# Picture -> relief slab (Gen+ -> Picture)

`nso_relief.js` (the generator, headless), `app-relief.js` (the card),
`fixtures/relief/` (a CC0 photo and a simulated scan),
`tools/nso_relief_test.js`, `tools/nso_relief_sculpt_test.js`,
`tools/nso_relief_drive_check.js`, `tools/nso_relief_scan_fixture.py`.

Trace raster turns line art into printed lines. Nothing turned a picture into a
surface. This does: an image becomes a flat base with a dense relief on top,
heights driven by the image, closed into one solid. It prints as it is (a
relief, or a lithophane held to the light) and it is dense enough for the
Brush to sculpt and lift into a figure. Lifting a painted region by a typed
height is the next ticket and is not here.

## 1. The generator - `NSO_Relief.build(image, opts)`

Input is `{ width, height, data, channels }`, the ImageData shape Trace raster
already takes - no decoder - and `{ widthMm, baseMm, reliefMm, sampleMm, levels,
darkIsUp }` (defaults 60, 2, 2, 0.3, 2, true - the ticket's - so a 60 mm square picture is
163,212 triangles; `maxTriangles` 400,000).

| step | what it does |
|---|---|
| grayscale | 0.299 R + 0.587 G + 0.114 B, Trace raster's weights; alpha composited over white |
| auto-contrast | the 1st..99th percentile stretched to 0..1, clamped outside. If those coincide (ink under 1% of a clean scan) it falls back to min..max; a single flat grey makes a plain base slab. `contrast.source` says which |
| quantize | `levels` equal bands, `floor(t L) / (L - 1)`; smooth leaves t |
| resample | an exact box filter: each sample is the area mean of the picture over its own cell, cells tiling the picture. A cell wholly inside one value returns it exactly |
| solid | one top vertex at every cell centre at `base + h relief`, a ring on the outline carrying the edge cells out to the full `widthMm x heightMm`; four vertical walls; a flat bottom at z = 0 that is the same grid. Every quad split on one diagonal - no T-junction anywhere |

    triangles = 4 (nx + 1)(ny + 1) + 4 (nx + ny + 2)      nx = round(widthMm / sampleMm)

Output is `rawTris`, Z up, the picture's top edge at +Y so it reads from above;
`samples`, `triangles`, `mmPerPixel` (reported back as Trace raster reports its
scale), the grid, the heights and the census. The census is taken on the index
buffer before anything is returned - every undirected edge twice, every directed
edge once, V - E + F = 2 - and a slab that fails it is refused, not returned.

**The budget.** `plan()` is the closed form above, so the card's line and the
refusal are decided before anything is allocated. Over budget is refused by
name, with the finest Detail in 0.01 mm steps that fits:

> a 4000 x 4000 picture 60 mm wide at 0.1 mm/sample is 1,449,612 triangles, over
> the 400,000 budget - Detail 0.20 mm/sample fits (364,812 triangles)

**Quantize comes before resample**, the order the ticket fixed. Where a cell
straddles a band edge it takes the box mean, so Levels N gives N heights in the
bands and anti-aliased heights along their edges. On camera.png at 0.2 mm,
93.05% of samples sit exactly on one of the 2 levels at Levels 2, 80.68% on one
of 4 at Levels 4, 48.48% on one of 16 at Levels 16. A grid aligned with the
picture (the checker test) has exactly N. Resampling first and quantizing after
would give exactly N heights everywhere at the cost of thin lines aliasing away;
that is swapping the two steps, if wanted.

### Why the floor is a full grid

The first version floored the slab with no interior vertex - a strip of quads
the full depth of the slab and a fan at each end, about half the triangles. It
closed and passed the canonical checker, and it could not be sculpted
(camera.png, Levels 8, 40 mm at 0.4 mm):

| tool, on the strip floor | result |
|---|---|
| Smooth (`NSO_smoothGlobal`) | refused, "volume loss 25.88% over budget" (27.36% in the app) - the Laplacian pulls each front-edge floor vertex toward the far edge it shares a 40 mm triangle with |
| Brush, Emboss | refused, "T-junctions rose 0 -> 18" headless, "self-intersections rose 0 -> 15" in the app - the refinement zone reaches through the 2.7 mm slab and splits the long floor edges |
| canonical checker | PASS, but 388 slivers on the floor before anything ran |

With the floor a grid under the top, Brush, Smooth and Cut pass their own gates
and the checker, and a fresh slab has 0 slivers.

## 2. The card - Gen+ -> Picture, and the loop through G-scope

Choose picture... (`image/*`, and `.heic` / `.heif` listed too), then Width /
Base / Relief mm, Detail mm/sample, Levels (2, 4, 8, 16, Smooth), Bright is
up, the live line `~ N,NNN triangles` (`NSO_Relief.plan`, so it is the count
the slab will have), Make piece and Undo.

The picture is read at full size through the browser's own decoder (an `<img>`,
a canvas on white, `getImageData`) - not downscaled first as Trace raster does,
because the box filter is the resampler and the budget, not a pixel cap, is what
refuses a grid too fine. A HEIC the browser cannot decode (every browser but
Safari) is refused as "this browser can't read HEIC photos; export it as JPEG
or use Safari", and the picture already on the card stays.

**Make piece does not touch the plate.** It opens the slab in G-scope through
`NSO_MICROSCOPE.openObjects` - the seam G-scope already had for any named Z-up
triangle groups - as a one-object document named after the file. Nothing is
added and nothing goes on the Undo stack. From there:

| control | where | what it does |
|---|---|---|
| Back to Picture | G-scope, Source row | closes G-scope and opens Gen+ -> Picture. The photo is still in memory and no control was touched, so Width, Base, Relief, Detail, Levels and Bright is up are as they were - no re-choosing |
| Make piece, again | the card | replaces the slab G-scope shows. Attempts do not stack |
| Undo | the card | one step back to the previous attempt: that slab goes back into G-scope and its photo and settings come back onto the card. Only the previous attempt is kept, so it is one step; the app's own Undo (the plate's) is not involved |
| Click to select region, click the slab, Export to plate | G-scope | G-scope's own way out. The slab arrives through `addModelFromZUpGeometry`, the ordinary ingest an imported STL takes, named after the file, with one `addModels` Undo step - an ordinary piece from then on |

**Placement.** A slab that reaches the plate is moved to free plate: the spot
nearest the bed's middle, on a 2 mm grid, where its footprint is wholly on the
bed and at least 4 mm from every placed piece's footprint as posed
(`placedFootprint`, the box drag uses, so a turned piece counts the room it
takes). A slab with no such spot - wider than the bed, or a full bed - lands
just past everything, clear of every piece, and the status says so. G-scope's
`onPlate` hook is how the slab comes back to Picture for this; addModel's own
seat (past the rightmost piece by its unturned width) is unchanged for every
other route. The search itself is `nsoFreeSpot` in app-core.js since Lift
(docs/LIFT.md) shares it; Picture calls it with no `near`, so it is unchanged.

**Paint scope: none** - it adds a piece and reads no existing geometry.

## 3. It sculpts

Headless (`npm run relief:sculpt`), camera.png at Levels 8, 40 mm at 0.4 mm:

| step | triangles | open | nm | chi | pierce | slivers | top mm | volume mm^3 | verdict |
|---|---|---|---|---|---|---|---|---|---|
| slab | 41,612 | 0 | 0 | 2 | 0 | 0 | 2.700 | 3247.69 | PASS |
| Brush emboss, 17 dabs, gate on | 41,612 | 0 | 0 | 2 | 0 | 0 | 3.695 | 3388.76 | PASS |
| Smooth | 41,612 | 0 | 0 | 2 | 0 | 0 | 3.683 | 3368.24 | PASS |
| Cut x < 20 (rawCut) | 21,620 | 0 | 0 | 2 | 0 | 266 | - | 1520.76 | PASS |
| Cut x > 20 | 21,620 | 0 | 0 | 2 | 0 | 274 | - | 1847.47 | PASS |

The halves add up to the whole to the third decimal. The slivers after Cut are
the cut engine's cap, not the slab.

In the real app (`npm run relief:drive`), the scan at Levels 8, 60 mm at 0.5
mm, 44,892 triangles, sent from G-scope to the plate: an Emboss stroke over open paper baked (8 dabs, open 0->0,
T-junctions 0->0, self-int 0->0, top 2.539 -> 3.501 mm, 4133.99 -> 4636.67
mm^3); Smooth ran (volume -0.66%); Split cut it into two sealed halves of 23,548
triangles each; Download selected STL wrote 23,548 triangles that the canonical
checker passes (open 0, nm 0, chi 2, pierce 0).

**Found, not fixed - the Brush on steep relief.** An Emboss stroke ACROSS the
scan's ink lines is refused by the brush's own gate, "self-intersections rose
0 -> 14", and the piece is left exactly as it was. Reproduced headless: the same
stroke with every dab aimed straight up bakes; with each dab taking the normal
of the triangle the cursor lands on - which is what the app's raycast hands the
brush - a dab on a ridge's flank is tilted 55.8 degrees, pushes sideways, and
crosses the next ridge. The gate is doing its job; the brush's per-dab normal on
a steep relief is the brush's behaviour, and changing it is out of this ticket.

## 4. Checks

| script | what | checks |
|---|---|---|
| `relief:test` | the generator: checker, gradient, 1-px line, photo at 2/4/16/smooth, each turned 90 degrees, budget, plan = build, edge cases, vm load; the canonical checker on every slab | 277 |
| `relief:sculpt` | Brush, Smooth, Cut, STL, canonical after each | 12 |
| `relief:drive` | the card in real Chromium; the loop - Make into G-scope, Back to Picture with every setting kept, Make again replacing, Undo one step, Export to plate named and posed on free plate, the app's Undo; the three pictures, the line, the plate untouched, Brush / Smooth / Cut / Export, the 4000 x 4000 refusal, placement on a busy and a too-small bed, the HEIC refusal | 65 |
| `relief:shots` | `relief:drive`, keeping its screenshots and numbers in `tools/relief-out/` (gitignored - screenshots go in the PR, never in the repo) | - |

Not here, on purpose: region lift, vectorising, edge detection, colour.
