# Support footprint: the beacons' outline is the surface's own edge (supports-footprint)

`nso_support_beacons.js` (`region.footprint`, `opts.insetMm`, `opts.footprint`, `opts.seedPitchMm`: the finer look, `footprintsOf`),
`nso_support_interface.js` (`opts.perimeter`: the sheet's outline; `opts.footprints`: the fill), `nso_support_gridpack.js`
(`opts.sheetPerimeter`, `opts.sheetFootprints`), the Supports card's outline and click test (`app-supports-card.js`). Gate: `npm run support:footprint` (`tools/nso_support_footprint_check.js`, ~1.5 min;
`--no-build` is the 5 s half).

## 1. The ticket, and what it looked like

The owner's, on the Supports card: *"fix the supports generation beacons to reflect the actual perimeter of the model / contact
surfaces so they don't stick over the edges and build odd interfaces"*, with five screenshots of the six reference heads
(`supp_ref.3mf`, Bambu's own tree-slim test parts) and `supp_ref.gcode.3mf` "as your guiding light for how each piece interacts
with the support mechanism".

The card outlined a hanging area as the edges of the beacon grid's cells that no other cell of the area shares
(`docs/SUPPORTS-CARD.md` section 5 had the flag: "the outline can pass the face by up to half a pitch"). Half a pitch was the
kind case. The detector (`docs/SUPPORT-BEACONS.md`) marks a cell from its centre *or from one of its corners*, and a cell
marked by a corner is mostly air; on a part turned to the grid at 45 deg (all six heads are diamonds in plan) every edge cell
is such a cell. Measured on the six heads, flat (the cell's share of 3 mm x 3 mm that lies on the surface it was found on):

| head | cells outlined | outside the surface | the grid's cells / Bambu's interface |
|---|---|---|---|
| Base | 20 | 41 % | 1.62 x |
| Oblique | 21 | 46 % | 1.86 x |
| Circular | 5 | 1 % | 1.43 x |
| Negative Sphere | 15 | 61 % | 2.47 x |
| Negative Sphere2 | 3 | 43 % | 0.54 x |

(the last column is the area of the cells over the area of what Bambu's G-code lays under the same head, its interface and
transition lines closed into a region; Bambu's 30 deg threshold). And the supports followed the outline, not the surface:

- a spot found by a corner **stands on the very edge**, so the tip's cap (2.5 - 4 mm wide) and the sheet's field (the caps grown
  1.25 mm) hang half off the part - the circles round the Base's rim in the owner's third picture;
- a rim thinner than the sheet's cells got a sheet of **its own**, centred on a spot at the rim's corner: the top of the Negative
  Sphere2's three sheets lay 41 % outside the part's plan, the Negative Sphere's 31 %, the Oblique's lone top sheet 44 %.

## 2. What Bambu does (read off the G-code, `support:footprint` section 2)

Bambu's interface and transition lines fill the part's **underside, to its edge**: the diamond of Base and Oblique (a hair inside
the edge: its lines run 0.1 mm in), the disc under Circular and Sphere, the thin rim round the Negative Spheres' cavities - and
nothing outside. The interface region (the lines grown 0.3 mm and shrunk again) against the footprint this ticket traces,
both at Bambu's 30 deg threshold:

| head | Bambu mm2 | footprint mm2 | ratio |
|---|---|---|---|
| Base | 111.4 | 106.3 | 0.95 |
| Oblique | 101.8 | 96.3 | 0.95 |
| Circular | 31.4 | 31.0 | 0.99 |
| Sphere | 21.3 | 20.2 | 0.95 |
| Negative Sphere | 54.7 | 38.4 | 0.70 (Bambu's second surface, the apex, 3 - 4 mm across: not detected, `SUPPORT-ONE-TRUNK.md` section 5) |
| Negative Sphere2 | 50.3 | 26.5 | 0.53 (the same) |

## 3. What is built

**The footprint** (`footprints()` in `detect()`, on when `opts.footprint === true` or `opts.insetMm > 0`). Each area (region) gets
the outline of the surface its spots hold:

1. The node grid is the beacon grid cut `round(pitch / 0.25)` ways (0.25 mm at 3 mm), over the area's cells and one ring round
   them (the surface may reach into a cell whose centre and corners missed it).
2. A node is **on** the surface when a column of the piece crosses there at a height that follows the surface from a node
   already on (it may have climbed `step x tan(angle)` and 0.05 mm: a face that needs holding is no steeper than the
   angle) and **needs holding** by the beacons' own test (`needOf`: steep enough, air under it, not a bridge, not painted).
   It is a flood from the spots' own nodes - not a plane through a spot, which a dome leaves behind. A cell whose eight neighbours all have a centre
   spot is whole and is not sampled.
3. The boundary is traced (marching squares), each crossing found again **on the columns** by six bisections (0.004 mm), the loops
   cleaned of collinear vertices and oriented by nesting: outer loops counter-clockwise, a hole (a cavity, a bore) clockwise, the
   surface always on the left of travel. `region.footprint = { loops: [[[x, y, z], ...]], areaMm2, stepMm, insetMm }`.

It is the surface, not the grid's: the tilted box of `support:beacons` is 1013.5 mm2 against the face's 1013.2, its vertices on
the face's edge to 0.002 mm, at 12, 1200 and 12288 triangles alike; turned 37 deg the Base is 106.4 mm2 against 106.3.
40 ms a head, 0.1 - 0.3 s on the 33,000 and 49,000-triangle library parts.

**The spots kept in** (`opts.insetMm`, the card asks 1 mm, `NSO_SupportBeacons.INSET_PRODUCT_MM`). In an area of **flat** faces (every one within
3 deg of the plate: Base, a cap, a plate), a face, gap or corner spot nearer the edge than the inset moves to the nearest node that is not, or - a
rim thinner than two insets - the node farthest from the edge within a pitch; z, normal and triangle come from the column there.
`beacon.moved = { from, mm }`, `beacon.clearMm`. Never a spot lost or added. **An area with a tilted or a curved face keeps its spots where the grid
put them** (Oblique, Circular, Sphere, a rim with a chamfer): the stair under a tilted plane and a flat sheet's reach under a dome are laid on tips at the
grid's own points, and a spot moved along a slope changes the height the levels are read at. The first version moved those too; Oblique's stair became
five bare tips, 0.00 mm of sideways clearance and a speck over the sheet's top (`support:onetrunk`), and Circular's sheet stood 2.6 mm under its dome.
A crease, a tip and a side spot have no surface to stand in and stay.

**The sheet's outline** (`opts.perimeter` of `sheet()`, the card's `sheetPerimeter`). A level's **field** - where a line's centre
may lie - and every **cap's rim** are held to where the part is over the stack's top (within 6 mm: it is the part's plan, not a reach; a flat sheet's own
0.9 mm reach, `flatGapMaxMm`, is the field's besides, as before), 0.2 mm in from where it stops. A cap that hangs slides toward its tip and then narrows
(the existing `capFoul` loop). A level whose sheet that leaves nothing of - a rim narrower than the sheet's 2 mm lines (`MIN_RUN_MM`) - is
built again with the outline to its edge, then grown out past it 0.3, 0.6, 0.9, 1.2 mm in turn (`PERIM_GROW_MM`), and only then
without it, as it was. `level.outline = { marginMm }` says which (`null` for the old way: `{ marginMm: null, why }`).
**What it costs.** Only a level with a tip within `PERIM_NEAR_MM` (3.6 mm: a cap, the field and the margin) of the part's edge is asked at all, and for
it the old way is built first: a level that fails that way fails as it did (the outline only takes field away; of the levels of the six heads and
the clamp, none the old way could not build was built with it). The clamp's one-trunk build is 12.8 s against 10.8 s (1.2 x); asked of every level, first
the outline and then the old way, it was 18 s, and 83 s before the old way was asked first (`support:workflow` section 11 gates it at 105 calibration loops).

**The finer look** (`opts.seedPitchMm`, the card asks 1 mm, `NSO_SupportBeacons.SEED_PITCH_PRODUCT_MM`). The 3 mm grid steps over what is narrower
than it: a 0.6 mm ledge is found in 5 of 12 alignments of the grid, a 1 mm one in 8, and a Negative Sphere's apex (3 - 4 mm across) not at all - the
"gap" between Bambu's interface and our spots. After the footprints are traced, `detect` looks again at 1 mm (`seedMissed`): a hit that is not inside
any footprint (and not within 0.6 mm of an edge of one at its height), of a surface that needs holding, that hangs at least 2 mm above what is under it
(`SEED_MIN_DROP_MM`: a chamfer at the plate is not a surface), becomes a **seed** (`need.seeded`). Seeds are traced alone, per height group, and kept when
the piece is 1.5 mm2 or more (`SEED_MIN_AREA_MM2`) and no existing beacon lies within 3 mm of an existing footprint at that height
(`SEED_NEAR_MM`: a seed beside a footprint is the grid's own rim, a crescent the sheet cannot carry - the first version let those in and the Negative Sphere's sheets
hung off the part again, 27 - 32 % outside). Seeds are separate areas, so a rim and an apex are planned apart. On the four heads and the clamp, the
tape, the v9 wedge and the top clip it finds nothing: byte for byte what the grid found (0 seeds). On the Negative Sphere it finds the apex (4 spots, a second
area of 19 mm2), on the Negative Sphere2 6 (9 in all, 4 areas of 3). Cost: one more `detect` at 1 mm, 30 - 240 ms on the heads and the wedge.

**The fill** (`sheet` `opts.footprints` = `NSO_SupportBeacons.footprintsOf(regions)`, with `perimeter`; the card's `sheetFootprints`). With the outline alone the
sheet stays on the part but only as far as the caps' field reaches (a cap and 1.25 mm): the Base's covered 72 % of its footprint. For a level with a tip
near the edge, the fill is tried first: the field runs `FILL_MM` (3 mm) past a cap's rim, wherever the footprint is (`inFeet`: the loops at the stack's height,
even-odd) and the part is within 1.2 mm over the stack's top. A level the fill cannot build (a rim thinner than the 2 mm lines, `no piece of 2 mm lines carries two
caps`) goes on to the outline and its steps as before, and `level.outline = { marginMm, fill: true }` says it was filled. The Base's sheet now encloses 81 % of its
footprint (86.2 of 106.3 mm2; the rectilinear pieces do not reach the diamond's rounded corners and a line keeps 0.2 mm in), 0 % of it outside the part.
**Only for a level of 16 tips or fewer** (`FILL_MAX_TIPS`): that is a few tips on a wide surface, what it is for; the clamp's 54-tip plate level already stands across
its surface, and its filled build cost 5.5 s for +0.5 % of the support. (`bestRect` counts a rectangle's caps by a closed form now, not by building the set per
rectangle: the same numbers, the filled build of a large level 3x faster.)

**The card** draws the area's loops (a ribbon on the inside of each, on the surface: the plane of the spot nearest the segment) and tests a
click against them: the ray meets the plane of one of the area's spots and the point is inside the loops
(`inFootprint`, even-odd). A spot the footprint does not hold (a crease, a tip, a side spot, one placed by hand, an area a
build split) keeps its cell, as it was.

## 4. Measured (`support:footprint`)

The six heads, the card's one-trunk Auto (Dense, spots 1 mm in, the sheet's outline on) against the same build as it was; the
sheet's top faces, and the share that lies outside the part's plan:

| head | flat faces of the stack and caps, mm2 | outside the part's plan, now | farthest out | as it was |
|---|---|---|---|---|
| Base | 844 | 0.0 | - | 18.7 of 576 (3 %) |
| Oblique | 160 | 12.3 (8 %) | 0.70 mm | the same (its stair is not changed) |
| Circular | 186 | 0.0 | - | 0.0 of 175 |
| Sphere | 192 | 0.0 | - | the same |
| Negative Sphere | 1066 | 205 (19 %) | 1.10 mm | 529 of 2020 (26 %) |
| Negative Sphere2 | 413 | 63 (15 %) | 1.10 mm | 161 of 395 (41 %) |
| **all six** | 2861 | **280 (10 %)** | 1.10 mm | 718 of 3400 (21 %) |

(The "flat faces" count every layer of the stack and the caps' top discs, so a head with several levels counts a surface several times. With the finer look and
the fill on; with the outline alone it was 254 of 3214 (8 %): the Negative Spheres' apexes, which were not built at all, are in the count now, 19 % and 15 % of
a bigger total. The gate wants no more than 12 % and 1.3 mm.) What the table does not show is the card: the outline of each of those areas is the footprint of
section 3, the Base's is the diamond's own edge where it was 20 cells hanging 41 % over the air, and a click is read against it. The Base's sheet is wholly on
the part now (0.0 mm2 out; the fill takes the corner tip that was 18 mm2 out into the main sheet's field); the Negative Spheres' remainder is rims narrower
than the sheet's 2 mm lines (section 6). `support:onetrunk` (the six built the card's way, 21 gates) holds: one trunk each, every spot held, 0.18 mm of gap and
0.35 mm sideways everywhere. The Negative Sphere2's two surfaces stand on one pad (2 trunks, 10.9 mm across against the 9.7 mm their bases span; the
gate reads a pad against the bases it holds).

**The gate for the fill and the apex** (`support:footprint`): the Base's sheet fills 78 % or more of its footprint (81 %: 86.2 of 106.3 mm2; 72 % with the outline alone), each
Negative Sphere has a level of the sheet over z 12 (its apex), a 0.6 / 1 / 2 mm ledge is found in all 12 alignments of the grid with the finer look (5 / 8 / 12
without), the four heads are unchanged by it, and the Negative Spheres' unfound share (what a 0.5 mm grid flags that the 3 mm grid and its footprints miss) is
22 % -> 0 % and 42 % -> 7 %.

## 5. Defaults: what is on, and where

Everything here is **asked for**; the engine's defaults are the claude-wip's, byte for byte (the planner suites pin the spots
where the grid put them and the sheets' bytes):

| | default | the card |
|---|---|---|
| `detect` `footprint` | off (no field is added to a region) | on, through `insetMm` |
| `detect` `insetMm` | 0 (the spots stay where the grid put them) | 1 mm (`detectOverhangs` `beaconInsetMm`) |
| `sheet` `perimeter` | off | on (`PARTS_OPTS.sheetPerimeter`) |
| `detect` `seedPitchMm` | 0 (no finer look) | 1 mm (`detectOverhangs` `beaconSeedMm`, `SEED_PITCH_PRODUCT_MM`) |
| `sheet` `footprints` | none (the fill needs `perimeter` and these) | on: `footprintsOf(det.beaconRegions)` (`PARTS_OPTS.sheetFootprints`, set in `runPiece`) |
| `sheet` `regionPlate` | off | on (`PARTS_OPTS.sheetRegionPlate`; needs `footprints`; section 9) |

`tools/nso_supports_print_export.js` `build(piece, partsOver, name, one, brim, outline)` takes the card's as its sixth argument: `true` is all four (`inset`, `seed`,
`perimeter`, `fill`), `'perimeter'` / `'inset'` the first versions, or an object of them; `support:onetrunk` and `support:footprint` use it.

## 6. Not done, and named

- **The sheet is not the whole footprint, still.** With the fill the Base's covers 81 % (its rectilinear pieces and a line's 0.2 mm in do not reach the diamond's
  rounded corners); Bambu's interface fills it to the edge. Only levels of 16 tips or fewer are filled (`FILL_MAX_TIPS`), because the filled build of a large
  level is slow; the clamp's plate level is built with the outline alone.
- **A rim thinner than the sheet's 2 mm lines** (Negative Sphere2's corner patches are 2.5 x 3.3 mm) still gets a sheet that
  reaches out past the edge: the least that makes one (up to 1.2 mm, the card's lines cannot be shorter). The gate allows it.
- **A stair** (Oblique's) is laid by its own code and is not held to the outline; its tips stay on the grid, four of them 0.14 mm from the
  plane's diagonal edge (the stair's strips keep to the part's outline themselves: `STAIR_REACH_MM`).
- **A tip too near a corner for a sheet of its own** (Base's left corner: the diamond's rounded corner, 2.3 mm across 1 mm in) gets the
  least piece that fits, reaching up to 0.9 mm past the edge. A better answer is to hold it from the main sheet's field; not done.
- **A dome's footprint** has four small spikes at its rim (Circular): the surface's angle crosses the limit between two facets.
- **The Negative Spheres' apex** is detected now (the finer look) and has a sheet; a small area (2.4 x 3.3 mm on the Negative Sphere, 4.4 x 3.8 on the Sphere2) can
  have a tip the planner cannot reach: on the Negative Sphere2 at 35 deg, one crest spot of the nine is left "unreachable" (3 tips hold the other 8; the plate
  test names it per piece: "Good1 · unreachable 1"). The planner's, not the finer look's: it is the same with the seeds' own beacons.
- **A rim thinner than the sheet's pieces** (the Negative Spheres' crescents, under 2 mm) is seen by the finer look only when it is not within 3 mm of
  a footprint at its height (`SEED_NEAR_MM`), because a seed beside a footprint is a crescent the sheet cannot carry and it hung off the part. The rims stay as
  they were.
- **An area a build split** (held in part, the lost spots an area of their own) draws the first part's whole outline and the
  rest in cells.
- **Hand-placed spots** (Shift-click) and the G-scope's markers (`app-gscope-support.js`) keep what they had: no footprint is asked for there.

## 7. What else moved (re-pinned, with the reason)

- `support:onetrunk` builds the six heads **the card's way** now (`PE.build(..., outline = true)`; `--as-it-was` for the old build): its 19 gates hold.
- `support:plate` section 6: Negative Sphere2's single-piece Generate is 9788 triangles (632cd214c51c, 12532 before), sha `a5af748eaf65` - its three
  sheets keep to the rim; Circular and Sphere are the bytes they were (the outline changes nothing under a dome that it did not already hold). Stable over
  two runs.
- `support:plate`, the finer look: Negative Sphere2 single-piece Generate is 23352 triangles, sha `7cccdebaa3bb` (16644, `90b737411a3d` before, on the lighter crowns): its apex is a fourth area
  with a sheet, and the sheets are filled; Circular and Sphere are the bytes they were. The plate's readouts move with the apex: `3 pieces · 8 hanging areas` (6),
  4 areas a piece (3), `5 pieces · 16 hanging areas` (12), the unreachable Cave 4 (3), and each built Negative Sphere2 has one apex spot unreachable ("Good1 · unreachable 1").
  Stable over two runs.
- `support:onetrunk`: the pad gate reads a pad against the bases of every trunk it holds (the Negative Sphere2 has two, on one pad).
- `support:workflow` builds: the clamp 101.9 calibration loops (gate 105; the committed code measured 102.7 on the same box that day; with the fill on every level it was
  112 - 117, before `bestRect` and `FILL_MAX_TIPS`), the wedge 43 loops, the longest quiet gap 4.0 loops (6.3).
- `support:workflow` section 1: the area's outline is "a handful of segments, the face's own edge" (`view().areas[].outlineEdges`) where it was the
  44 edges of the 12 x 10 cells; section 7: the tunnel ceiling's spots by the mouths 28 held / 68 unreachable (24 / 72): the card moves the ceiling's spots
  0.5 mm from the bore's walls and the mouths' edge in to 1 mm, and the planner's lean limit is a sharp cutoff. The 96 spots are the same 96.
- Everything with the options off is byte for byte what it was: `support:index` (its plan hash is why `footprint` is only added when asked),
  `support:everywhere` (its fixture hashes), `support:feed`, `support:gridpack`, `support:exposed`, `support:interface-fixtures`,
  `support:shells-coupon`, `tree:interface`, `slicer:supports`, `slicer:brim` all pass unchanged.

## 8. The plate, measured: time and coverage (2026-10-27, after the finer look; the region plate of section 9 supersedes the open items below)

Two tools: `npm run support:coverage` (`tools/nso_support_coverage_check.js`: the six heads built as a plate in the card's own code, aligned and turned about z,
each footprint read for **support just under it**: a face of the stack 0.02 - 1.5 mm below the surface) and `node tools/nso_support_plate_browser_time.mjs` (the
same plate in headless Chromium, the real worker, the clock on GENERATE).

**Time** (this box; the old commit is 1eec7de, before the outline and the beacon work). The plate, node / browser, seconds:

| | node, aligned | node, turned | browser, aligned |
|---|---|---|---|
| 1eec7de | 15.4 | 17.5 | 12.5 |
| upstream's tip with the outline (6112b2c) | 22.4 | 24.6 | 19.0 |
| with the finer look and the fill (d95855f) | 36 | 45 | 24.4 |
| now (the geometry queries kept by their arguments; same bytes) | 30 | 44 | 22.5 |
| outline off, seeds off (the sheet as it was) | 18.0 | | 15.1 |

The outline (`sheetPerimeter`) is about 3.4 s of the browser's plate and the finer look 4.5 s (10 s and 8.6 s in node). Both are paid in **one place**: the last-resort
sheets (`lateTry`, nso_support_interface.js): a tip no level or stair carried gets a level of its own, tried down to eleven times (`LONE_SINKS`), and with the outline each try
is the old way, the outline, and its growth steps. On the turned plate that is 28 levels and 30 of its 44 seconds, 23 of them ending in no sheet at all. The tips that go there are the
Negative Spheres' rims (a ring about 1 mm wide: the sheet's pieces need 2 mm lines), their apexes, and the domes' outer tips. Nothing here is a bug in the finer look: it is the cost of asking
for a sheet where none fits. What was done: `hitIn` / `firstHit` / `inside` / `nearestPt` and `markInside`'s rays are kept by their arguments (a level is built several times); same bytes, 36 -> 30 s aligned.

**Coverage** (`support:coverage`, the share of each footprint with support under it):

| head | 1eec7de | now, aligned | now, turned (20, 35, 12, 28, 40, 8 deg) |
|---|---|---|---|
| Base | 88 % | 88 % | 88 % |
| Oblique | 94 % | 92 % | **12 %** |
| Circular | 35 % | 35 % | 61 % |
| Sphere | 64 % | 64 % | 61 % |
| Negative Sphere | 37 % | 61 % | 41 % |
| Negative Sphere2 | 34 % | 50 % | 41 % |

The finer look and the fill are what raised the Base (71 -> 88 % on upstream's tip) and the Negative Spheres. What is **open**, and was before:
- **The Oblique's stair stands at two angles only** (0 and 75 deg; 15 - 60 and 90 turn it to 7 - 39 %, on the old commit too: `tools/nso_support_coverage_check.js` finding, and the card's
  plate with turned pieces shows it): the stair's lines follow the sheet's line angles (`STAIR_SNAP_DEG`). A plate whose pieces are turned is the usual plate.
- **A dome (Circular, Sphere, the Negative Spheres' apex) is one flat patch at its lowest tip's height**: the rest of the surface rises out of the flat sheet's 0.9 mm reach; the planner
  still calls those spots held "through" a tip within 3.3 mm in plan (`ONE.coverMm`), whatever their height. Bambu steps its interface up the dome in rings.
- **A ring or a crescent 1 mm wide** (the Negative Spheres' rims) takes no piece of the sheet; its tips get a last-resort square that hangs out over the air (the outline's growth steps), or nothing.
  Leaving a tip on a footprint narrower than 1.8 mm a plain tip (no last-resort sheet) was tried: the plate 45 -> 33 s turned, 32 -> 25 s aligned, the Negative Sphere aligned 61 -> 33 %. Not shipped: it is a trade
  of interface for time, and the rim is the part's own thinnest.
- The Negative Spheres' apex sits in a closed cavity on the stem: one crest spot is "unreachable" (nothing comes up to it from the plate); the card says so.


## 9. The region plate: the interface laid from the footprint, not from the tips (2026-10-27, third round)

**Why.** Sections 6 and 8 end the same way: the sheet is built from the *tips* (caps, a field round each, levels of tips, a lone-tip last resort), so what it covers is
what the tips reach, and on a dome, a curve or a rim it covers a third of the surface at the cost of eleven tries per lone tip. Bambu does not work from tips. Read
layer by layer, its interface and its transition look like a **raft grown on the surface**: for every print layer, the cells whose stack takes that layer; an outline loop
hugging the region's edge, and a hatch inside it turning 45 / 135 deg a layer; on a dome the plate grows and shrinks layer by layer. So the generator takes a **region**
(the footprint's cells, their height) and nothing else; where the region comes from (the detector's footprint today, a painted mask tomorrow) is not its business.

**What it does** (`nso_support_interface.js`, `shellPass()` in `sheet()`; on with `opts.regionPlate`, the card's `PARTS_OPTS.sheetRegionPlate`, needs `footprints`):
1. For each footprint (the smallest first, so the bar moves early), the surface's height is read on a 0.2 mm lattice (`firstHit` upward from `zl - SHELL_START_MM`), filled
   to the 0.1 mm raster by the lowest of the four neighbours (never over the surface), and a footprint whose 2nd - 98th percentile varies by at most `REGION_FLAT_MM`
   (0.3 mm) is **one flat face** at its lowest height. A footprint that is one planar slope of 3 - 70 deg (within `REGION_PLANE_MM` / `REGION_PLANE_SHARE` of one plane) is a
   **stair's** and is left to the stair: the Oblique is untouched.
2. The usable cells are the footprint's, `REGION_MARGIN_MM` (0.1 mm) in from its edge, less the **other columns** (every column the footprint's tips do not stand keeps the same
   clearance from the plate as from a sheet) and less the **part's own walls** beside it (a stem, a tab: read at the stack's heights, clear of the gap and a half line).
3. Every usable cell has a **stack** of `NL` = 5 layers (2 transition, 3 interface: `SHEET_ROLES`) whose top is the surface less the gap, quantised to the layers; under a slope the gap
   is the perpendicular one (`gap / cos(tilt)` from the lattice's local slope). A flat face is one level; a dome is a stack per cell, so the plate steps up it.
4. For each print layer `n`, the mask of cells whose stack contains `n` is cropped, smoothed (`smoothMask`, the height map's steps go) and laid by `plateOfRegion`: **an outline loop**
   (the first concentric loop of the distance to the edge, `concentricLoops`, opened by half a line and its gap so no two walls are nearer than a line) and **a hatch** at 45 or 135 deg,
   a pitch (the sheet's dense 0.47 + 0.03 mm) apart on a lattice fixed in the plane (two layers of one direction stack line on line: *flush*), each line running a line's gap short of the loop. A region too thin
   for a hatch (nothing left inside the loop and a gap) is laid in concentric loops alone. Every layer is extruded (`extrudeFlat`: no overlap, no short segment: `fitRing` makes a loop fit,
   and a layer the extrusion refuses is asked again from a smoother mask, then with more room, then as its loops alone).
5. The plate is **checked as a sheet is**: the exact distance to the part and to the other pieces (`minDistanceMm >= gap`), and a plate that fails is not built, the footprint goes the ordinary way.
   The tips inside the footprint stand under it as **carriers** cut to the plate's bottom (`shellB`): no cap, no sheet of their own (`capWhy: 'no cap: the region plate lies on the tip itself'`).

The progress bar is told as the plate goes (a tenth after the surface is read, three tenths after the fill, half when the walls stand, then by layer), because the first footprint costs about two seconds
and the card's "Building moves within its first 3.5 loops" gate (`support:workflow-builds`) would otherwise read it as a still bar.

**Measured** (this box; `support:coverage` and `support:plate`, the six heads on the plate, the card's own code):

| | before (section 8, `d95855f`+) | region plate |
|---|---|---|
| plate, node, aligned / turned | 30 s / 44 s | **15.3 s / 20.7 s** |
| Base, aligned / turned | 88 % / 88 % | 83 % / 86 % |
| Circular | 35 % / 61 % | **88 % / 78 %** |
| Sphere | 64 % / 61 % | **98 % / 98 %** |
| Negative Sphere | 61 % / 41 % | **68 % / 64 %** |
| Negative Sphere2 | 50 % / 41 % | **71 % / 70 %** |
| Oblique (stair untouched) | 92 % / 12 % | 94 % / 12 % |

The time is the point of the second half of the ticket: the lone-tip tries (`lateTry`, `LONE_SINKS`) are not asked of a tip a plate carries, which is where section 8's 30 of 44 seconds went. Turning a head
now moves its share by 10 points or less (the plate follows the surface; the stair's lines follow the sheet's angles, which is why the Oblique alone still drops).

**Gates.** `support:region` (`tools/nso_support_region_test.js`): the geometry on rasters of known answer (the exact distance, a circle's level set, the smoothed mask, the plate of a rectangle:
one loop, a hatch flush on its lattice at 45 and 135 deg, never nearer the loop than a line, the strip too thin for a hatch, the speck, the disk's concentric rings) and that the extrusion takes every layer.
`support:coverage`: floors per head, aligned and turned, the turn moving no head but the Oblique by more than 15 points, and ceilings on the plate's seconds. `support:plate` section 6 is re-pinned
for the three single-piece builds the region plate changes (Negative Sphere2 27568, Circular 14128, Sphere 15152 triangles). Everything else is unchanged with the option off.

**Not done, and named.**
- **A rim or a crescent under about 1 mm** gets its outline loop and no hatch (a plate of loops alone); the thinnest are dropped (`REGION_MIN_LOOP_MM`). The Negative Spheres' remaining 30 % is mostly these.
- **The stair (Oblique)** is not touched; it is being reworked on its own, and a region that is one planar slope is handed to it (`STAIR_MIN_DEG` .. `STAIR_MAX_DEG`).
- **A painted region** is the same generator with a mask in place of the footprint; the card has no paint tool for it yet. The generator takes a raster and a height per cell, so a mask drawn on the surface needs
  only to be rasterised and handed to `shellPass`'s per-footprint step.
- **Printability is not tested.** The plate is held to the slicer's own rules (Bambu's typing closes gaps of 0.5 mm radius and fills the sheet's zones itself; the plate's lines are 0.4 mm apart in the same way the
  sheet's are), but no print has been made from it.
- **The Base is 5 points under section 8's 88 %** (83 aligned, 86 turned; the same plate with `sheetRegionPlate` off measures 88 again, so it is the region plate's). Of the 71 samples of its footprint with no support
  under them (of 424), a quarter lie within 0.13 mm of the footprint's edge (the plate's margin: its cells start 0.1 mm in and its wall is a line wide) and the other quarter lie 0.7 - 4 mm in, where the clearance of
  another column or the part's own wall takes cells out of the plate. Not traced further; the Base is a flat face and a plate should hold it whole.
