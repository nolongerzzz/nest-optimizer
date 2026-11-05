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
3. Every usable cell has a **stack** of `NL` layers (the card's Dense: 2 transition under 2 interface, `SHEET_ROLES`; it was 2 + 3 until upstream's "interface 2 + transition 2") whose top is the surface less the gap, quantised to the layers; under a slope the gap
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
| plate, node, aligned / turned | 30 s / 44 s | **15.6 s / 19.1 s** |
| Base, aligned / turned | 88 % / 88 % | 83 % / 86 % |
| Circular | 35 % / 61 % | **88 % / 77 %** |
| Sphere | 64 % / 61 % | **98 % / 98 %** |
| Negative Sphere | 61 % / 41 % | **67 % / 64 %** |
| Negative Sphere2 | 50 % / 41 % | **70 % / 70 %** |
| Oblique (stair untouched) | 92 % / 12 % | 94 % / 12 % |

The time is the point of the second half of the ticket: the lone-tip tries (`lateTry`, `LONE_SINKS`) are not asked of a tip a plate carries, which is where section 8's 30 of 44 seconds went. Turning a head
now moves its share by 11 points or less (the plate follows the surface; the stair's lines follow the sheet's angles, which is why the Oblique alone still drops).

**Gates.** `support:region` (`tools/nso_support_region_test.js`): the geometry on rasters of known answer (the exact distance, a circle's level set, the smoothed mask, the plate of a rectangle:
one loop, a hatch flush on its lattice at 45 and 135 deg, never nearer the loop than a line, the strip too thin for a hatch, the speck, the disk's concentric rings) and that the extrusion takes every layer.
`support:coverage`: floors per head, aligned and turned, the turn moving no head but the Oblique by more than 15 points, and ceilings on the plate's seconds. `support:plate` section 6 is re-pinned
for the three single-piece builds the region plate changes (Negative Sphere2 24332, Circular 13760, Sphere 12888 triangles (on the 2 + 2 stack, with sections 10 and 11)). Everything else is unchanged with the option off.

**Not done, and named.**
- **A rim or a crescent under about 0.7 mm** is still bare: a bead needs the region a half line and a gap in from its edge on both sides, and the footprint's own 0.1 mm margin comes
  off first. The Negative Spheres' remaining 25 - 40 % is mostly these (the bowl's rim is a ring that tapers to a sliver at its far side); the brush below reaches them.
- **The stair (Oblique)** is not touched; it is being reworked on its own, and a region that is one planar slope is handed to it (`STAIR_MIN_DEG` .. `STAIR_MAX_DEG`).
- **A painted region** is the same generator with a mask in place of the footprint; the card has no paint tool for it yet. The generator takes a raster and a height per cell, so a mask drawn on the surface needs
  only to be rasterised and handed to `shellPass`'s per-footprint step.
- **Printability is not tested.** The plate is held to the slicer's own rules (Bambu's typing closes gaps of 0.5 mm radius and fills the sheet's zones itself; the plate's lines are 0.4 mm apart in the same way the
  sheet's are), but no print has been made from it.
- **The Base is 5 points under section 8's 88 %** (83 aligned, 86 turned; the same plate with `sheetRegionPlate` off measures 88 again, so it is the region plate's). Of the 71 samples of its footprint with no support
  under them (of 424), a quarter lie within 0.13 mm of the footprint's edge (the plate's margin: its cells start 0.1 mm in and its wall is a line wide) and the other quarter lie 0.7 - 4 mm in, where the clearance of
  another column or the part's own wall takes cells out of the plate. Not traced further; the Base is a flat face and a plate should hold it whole.

## 10. Thin beads, the hatch given up, the paint brush and the raft switch (2026-10-27, fifth round)

The owner's report on the live card (angle 30): "the interfaces look much better... still not reaching the spheres", then "add a raft in the card as well... a supports-on-demand paint
brush would help fill in some of the gaps". Is it detection or the supports? **The supports.** `tools/nso_support_coverage_check.js`'s samples are the *detected* footprint, and the
bare ones are inside it; and of the surface that faces down within 30 deg and is open to the plate, the detector's footprints hold 100 / 97 / 96 / 84 / 97 / 90 % (Base, Circular, Negative Sphere,
Negative Sphere2, Oblique, Sphere: the misses are the Negative Sphere2's apex seeds and the crest). At 30 deg the build held the Sphere 82 %, the Negative Sphere 55 %.

**What was wrong in the plate for the bowls.** The Negative Sphere's contact surface at the bowl is a ring about 2 mm wide that tapers to under 1 mm. Three things took lines away:
the layer mask was smoothed by 2 cells (0.2 mm) three times, which erases a strip under about 0.6 mm; the outline's opening needs about 0.9 mm for a loop on each side; and a hatch laid in a narrow
ring is cut into stubs under the least line (0.9 mm) and dropped. Now: (1) the mask is smoothed by 1 cell (more only when a layer is refused); (2) a region whose hatch lines fill less than 60 % of the room
inside its outline (`HATCH_MIN_SHARE`) is laid in concentric loops instead; (3) **thin beads** (`thinLines`): the cells a half line in from the region's edge and a line and 0.06 mm from every path
laid are thinned to one pixel (Zhang - Suen), traced into open polylines, cleaned (Douglas - Peucker, no segment under 0.6 mm), and each is one bead along its sliver - extruded with the loops, dropped first when a layer is refused.
Measured (`support:coverage`, aligned / turned, then at 30 deg): Negative Sphere 67 -> 75 % (30 deg: 55 -> 60), Circular 88 -> 90, Base 83 -> 84, Sphere at 30 deg 82 -> 89; the Circular turned is 78 against 90 aligned (the floor 72).

**The raft switch** (`#sup-raft`, on): `partsOptsOf(o).sheetRegionPlate`. Off is the sheet from the tips alone; on the Circular's dome it holds 50 % against the raft's 99 %. **Auto no longer reads it** (the owner, Oct 28: the platform under a flat face is the tree's own interface and transition, tied to the box by accident; raft is a support type of its own): the one-trunk tree always lays the plate, and the box gates only the other builds. Measured with the box off on the Negative Spheres' lower plate: the tips' sheet covered 52 - 60 % of the face in patches and the plate does what the box on did.

**A ring plate, the same on every layer** (the owner's Oct 28 slice: the Negative Sphere's lower interface "pretty bad"). The lower plate is a flat ring round the cavity - four sides 1.1 mm wide and four corners 2.4 mm across, 42 mm2. The hatch's angle turns each
layer (45 / 135) and the plate chose its recipe by a share test the angle decided: outline loops and a few lines on one layer, edge-to-edge lines alone on the next (`plateOfRegionCore`'s fallback), the lines of the
second crossing the bands they cannot fit. Measured (the plate alone, Bambu's layers hold 80 - 94 % of the face): 55 % on the 45 deg layers, 70 on the 135, and in the card's build 37 / 61 / 37 / 61 over the four layers. A region of 20 mm2 or more
whose hatch share fails now takes the outline loops and the hatch inside them (lines down to `RING_LINE_MIN_MM` 0.5) when that lays `RING_OUTLINE_GAIN` (1.25) times the length of the lines alone: 56 / 61 / 56 / 61 % in the card's build, the same
recipe on every layer. A small patch (the Negative Sphere2's, 9 mm2) keeps its edge-to-edge zigzag. `support:region` section 4 holds it on the real footprint, placed where it lies on the plate (the lattice is fixed in the plane, and a
test that centres the ring does not see the fault). **Left:** 56 - 61 against Bambu's 80 - 94: the ring's four sides are one loop each side of 1.1 mm with a gap between, and the cavity's trunks cut it; Bambu's zigzag crosses the band.

**Rungs joined to the loops: tried, and taken back** (f975c3b, reverted). Bambu's plate round the Negative Sphere's cavity is a loop on each edge and, between them, lines across the band (79 - 80 % of the face; ours 56 - 61). A plate of the loops with rungs from vertex to vertex, joined at nodes so the extrusion would take them, held 73 - 81 % of the face in the plate alone and 75 % in `dump2`'s slice - and **broke the real slice**: the support is a mesh, and NSO's slicer reads a bead network that touches itself as one polygon with a pocket between every two rungs, so it walks each pocket (the ring came out as cells, with gaps at the sides and the loops gone: interface 188 -> 151 mm on the Negative Sphere in the owner's gcode5, 93 -> 63 on the Sphere). The plate's own coverage number, the 3D coverage check and `support:region` all passed; only the slice (`NSO_Slicer` on the card's build, one head: `card_ns` in the notes) showed it. What the slicer takes well is beads that **do not touch**: each a thin strip, one pass down its middle (`detect_thin_wall`), and a loop on its own. So a plate must be loops and lines that stand a line and a gap apart, or lines alone; never a joined network. Judge a plate change by the slice of the card's build, not the plate alone.

**The slab for the thin plates** (`sheetSlabPlate: 'weak'`; `slabOfMask`). *Superseded in the card by `true` (every region plate a slab) with three interface layers: see "Every plate a slab, three interface layers" below.* A region plate whose loops, lines and thin beads cover under `SLAB_WEAK_SHARE` (75 %) of its region is laid as the region's footprint, one solid prism a layer high, and the slicer lays the zigzag itself, as it does for a sheet. Measured on the slice of the card's build (frame aligned on the part's own outer wall; coverage of each footprint against Bambu's, `covcard`): the Negative Sphere2's three crescents 56 / 59 / 33 % -> 88 - 99 % (Bambu 86 - 92), the Negative Sphere's lower ring 62 -> 94 % (Bambu 79 - 80), its apex ring 34 -> 42 - 77 %. Per head, interface / transition mm (Bambu): Circular 101 / 136 -> 252 / 202 (278 / 189), Sphere 82 / 92 -> 234 / 105 (198 / 110), Negative Sphere 188 / 148 -> 340 / 296 (479 / 338), Negative Sphere2 149 / 81 -> 258 / 235 (437 / 304), Base 373 / 372 -> 679 / 673 (777 / 528: the transition is over). Plate-level loops, lines and rungs could not do it: the crescents are 0.5 - 1.8 mm wide, tapering to bead-wide arms, and what does not touch holds 50 - 60 % of them at any angle; rungs across their skeleton (spaced a line and a gap, no nodes) held 32 - 35 % in the slice, worse than the loops. Two guards, found by `support:paint`: an island of the footprint under `SLAB_MIN_MM2` (3.5) is no slab (painting everything left specks of footprint inside the part, which the loops drop and a slab filled: 19 samples inside on the Negative Sphere), and a cap whose triangles do not add up to the ring's area less its holes' is refused (the caller then lays the loops and lines). `slabPlate: true` slabs every region (Base interface 554, transition 764); `false` is the loops and lines.


**Every plate a slab, three interface layers** (the card's default since the owner's gcode8 review of the Base). Base's plate (a wide hatch the 75 % test left as loops and lines) came out as separate bars a line-gap from the outline, over four layers (2 transition + 2 interface); Bambu's is the outline and one continuous zigzag over five (2 + 3). Two changes: `sheetSlabPlate: true` (the slicer lays the zigzag, joined at the turns, for every region plate) and `SHEET.denseInterfaceLayers` 3 (the card hands the slicer `meta.interfaceLayers`, which it already read). Headless per head, interface / transition mm (Bambu): Base 833 / 554 (777 / 528), Negative Sphere 491 / 294 (479 / 338), Negative Sphere2 392 / 232 (437 / 304), Circular 348 / 176 (278 / 189), Sphere 341 / 108 (198 / 110), Oblique 736 / 180 (851 / 468). A third slicer fix came with it: the first layer of a slab stands on the hollow tree, so the slicer gave it a bottom-shell fill and then the sheet's own fill over it (that layer 489 mm against 275 for its neighbours); where the sheet fills a region, no other fill of the layer lies in it (`nso_slicer.js`, the sheet block; the walls stay). Still open: the Sphere and Circular lay 6 interface layers (two stacks) where Bambu has about 3, and the Oblique's stair is short on transition (180 against 468).

**A flared cap under every region plate.** With every plate a slab the plate lies on its tips, and a tip under it got no cap (`no cap: the region plate lies on the tip

**Where the cap meets the plate.** A tip's cap ends at the lowest layer of the plate that *covers the tip* (`maskLayers`), not at the layer its cell's stack calls the lowest: that stack can be a speck the traced mask drops, and the plate there begins a layer higher - the Negative Sphere's apex pillars ended at z 12.7 under a ring that began at 12.9, one empty layer between the tree and the transition. And the cap never stands out past the plate: its width is held to twice the distance from the tip's top to the edge of that layer's mask (`flareOf`), down to `CAP_TIP_MIN_MM` (0.5 mm) where the plate is a thin ring or neck, so it tapers to the plate's width instead of showing past the interface's outline.
itself`): each leg ended as a bare 1.2 mm column - in the viewer, a tube - under the transition. Bambu's leg widens into a bowl 3 - 5 mm across over its last
2 mm and the transition starts on that platform. `flareOf` (`nso_support_interface.js`, option `regionFlare`, the card's `sheetRegionFlare`) gives each
such tip the sheet's own cap: a round frustum from `CAP_RISE_MM` down its leg to the plate's base, as wide as 1.4 x the distance to its nearest neighbour,
held to `CAP_MAX_MM` (neighbours' caps run into each other, which is the one platform Bambu's bowls make), and narrowed in the gridpack until it keeps the gap to the
part (`capped`). Circular's transition goes from 176 to 233 mm (Bambu 189); at the layer under the first transition line the five tips are one hollow rim.

**The brush** (`app-supports-card.js`, the Paint row; docs/SUPPORTS-CARD.md "The brush and the raft"): a stroke is an op of the piece's edits; `effective()` turns it into spots every 2 mm (`PAINT_SPOT_MM`) and
`paintFootprints()` into footprints for the raft: the brush's cells (0.2 mm raster) less every detected footprint, each piece traced (`api.region.isoLoops` of its distance) with the stroke's heights
(`zl`, `zh` the samples' less / plus 1.2 x the brush's radius and 0.3 mm), `marginMm: 0.02`; a detected footprint a stroke went over keeps `marginMm: 0.02` for the usual 0.1 (`shellPass` reads it), and a painted
region may be as small as 0.8 mm2 (4 for a detected one). Every check the raft has still stands - the exact distance to the part (`dmin >= gap`), the other columns, the part's own walls - so **a painted region
never crosses the line**; what the planner cannot reach, the card still says unreachable. `support:paint` (`tools/nso_support_paint_test.js`): the Negative Sphere at 30 deg built, its 80 bare footprint samples painted over in twelve strokes (brush radius 0.8 mm), built again:
**0 of the 80 held before, 51 after** (64 %), the footprint 127 -> 149 of 207 samples, no support face within the gap of the surface at any painted point, each stroke and Clear one Undo step; and the raft switch on the Circular (99 against 50 %).
The pointer path (drag raycast, the dots, Escape) is not exercised by a drive check; the node test drives the same ops through `paintStroke`.

**What the first version did wrong (reported from the live card).** The brush took the first face the ray met, so a stroke from above painted the visible top and the walls, a blob the stencil-less
dots drew opaque, and the spots it asked for sat on faces that hold nothing (walls, up-facing rims: 3 - 5 of them came back unreachable and the build grew by a third); and a stroke over a steep flank gave
a raft footprint the extrusion could not follow (a layer's band on a 55 deg flank is 0.8 mm / tan(55) = 0.56 mm wide). Now: the ray is cast with the material double-sided (the faces that hang are
the mesh's back faces from above, which a ray otherwise passes), the first hanging face is the hit, `paintNz()` limits it to the card's angle (normal below -cos(angle), 20 - 60 deg), and the paint
is a stain on the faces the brush covered (below). A strut through the model, reported with "paint and raft": **not reproduced** - about two dozen builds of the Negative Spheres, the paint from four sides and the old face
filter, tree and strut and gecko-hand, one piece and the plate, with the raft on and off, none had a support triangle inside any body (`support:paint` section 5 now holds that, sampling every seventh
triangle of the support against all three parity rays), and the straight-strut style has one sampled triangle at the Negative Sphere2's apex tip (z 16) inside the part's surface with nothing painted at all (a tip touching the face it holds). If it happens, the piece, the style and the strokes
are what is needed.

**Not done.** The remaining 36 % of the painted points are slivers under about 0.6 mm: a bead does not fit a footprint that narrow with the margin the plate keeps. The brush's reach on a steep flank
(its `zl`, `zh` are a stroke's heights plus a margin: a flank steeper than about 50 deg under a big brush takes a first hit from another face) was not measured; the Oblique's stair is the stair's and a painted
region on a planar slope is still handed to it. Paint is not drawn on the plate view (one piece at a time, as the tips are), and is kept per piece across Generate, not across CLEAR PLATE.

## 11. The spheres against Bambu's own slice: the plate runs to the face's edge (2026-10-27, sixth round)

"The latest auto builds are getting better without the paint. Let's push the additional detection needed to finish the spheres, as flat and oblique are almost perfect now."
First the question: what does Bambu hold, and what do we? `tools/nso_support_reach_check.js` (`npm run support:reach`) reads Bambu's slice of the six reference heads
(`fixtures/supports/tree_slimsupports.gcode.3mf`: the same six heads and 55553 moves as the supp_ref slice) the same way for both: the part's down-facing surface in 0.25 mm cells binned by tilt;
Bambu holds a cell when an interface or transition line of its stands within 0.5 mm in plan, on a layer 0.05 - 1.8 mm under it; the card holds it when a face of its support is 0.02 - 1.5 mm under the
cell or one within 0.5 mm is (the same dilation: a pitch of 0.5 mm with 0.4 mm lines leaves 0.1 mm between, and a cell centre sampled in the gap is not bare). The card at 35 deg / Bambu:

| tilt band | 0 - 20 | 20 - 35 | 35 - 50 | 50 - 65 | 65 - 80 |
|---|---|---|---|---|---|
| Circular | 93 / 93 | 100 / 93 | 35 / 21 | 0 / 0 | 0 / 0 |
| Sphere | 85 / 85 | 100 / 96 | 56 / 1 | 0 / 0 | 0 / 0 |
| Negative Sphere | 97 / 97 | 100 / 69 | 73 / 32 | 53 / 32 | 98 / 63 |
| Negative Sphere2 | 80 / 89 | 100 / 61 | 32 / 1 | 3 / 0 | 45 / 31 |
| Base, Oblique | 99 / 100, 98 / 100 | 99 / 100 | | | |

**So the spheres are at Bambu's own reach**: Bambu holds a dome to 35 deg and no further (the Sphere 35 - 50 deg: 1 %), the Negative Spheres' flat faces 97 / 89 % and their cavity walls in part; the card holds the
same or more in every band but one (the Negative Sphere2's flat face, 80 against 89). **Detection is not what is missing**: the flat surface outside every footprint that Bambu holds and the card does not is 0.0 - 0.3 mm2
a head (the apex crests, 1 - 1.6 mm2 each, are traced as a hole in the apex's footprint and sit within 0.5 mm of its plate). The strict reading (a face under the cell itself, no dilation) was the misleading one: a 0.5 mm hatch
pitch is 80 % of its own area to the cell.

What was left, then, was the plate's edge. `REGION_MARGIN_MM` was 0.1: the plate's cells lay 0.1 mm in from the footprint's edge and its first loop 0.1 more, so a band 0.15 mm wide was bare all round a rim 1 - 2 mm wide
and the bare cells were two thirds of the rim's perimeter (`flat_gap`: of the Negative Sphere's 14 mm2 of bare flat face, 11 were within 0.5 mm of the face's edge). The footprint's edge is the face's own edge, a plate may run to it:
**0.02**. Strict coverage (`support:coverage`, aligned): Base 84 -> 89, Circular 90 -> 99, Sphere 97 -> 98, Negative Sphere 75 -> 83, Negative Sphere2 71 -> 77; at 30 deg: Circular 94 -> 97, Sphere 89 -> 94, Negative Sphere 60 -> 76.
With the margin gone the brush of section 10 has little left to add on these heads (the bare points that were 80 are 51; `support:paint` now holds that a stroke never makes it worse).
A hole in a footprint under 3 mm2 (`REGION_HOLE_FILL_MM2`) is laid over by the plate: the crest of a cavity's apex is a cone 0.2 - 0.4 mm over its rim that the detector traces as a hole (Negative Sphere 80 -> 83).

**What is left.** The Negative Sphere2's flat face (80 against 89): the three corner patches' tails, 0.3 - 0.5 mm wide, where a 0.4 mm bead does not fit (`THIN_NARROW_MM` 0.06 was tried: no gain). The brush covers them where
the footprint is wide enough; the rest is the bead's width. Turning a head moves its share by up to 20 points (the Circular 99 aligned, 80 turned: the columns of its other tips cross its plate - `carve` - and the planner's choice of tips follows the grid).

**The stain (seventh round).** The brush's paint was drawn as screen-facing discs at the samples, floating over the piece and blurring where it applied. It is the piece's own triangles now (cut to 1 mm so the stain
follows the brush's edge across a flat face): the hanging ones within a brush radius of a sample, lifted 0.03 mm, solid on the face (hidden when the face is behind the piece) and faint through it, redrawn when the piece moves.

## 12. The owner's slice of the card's supports, and where Bambu's 30 really reaches (2026-10-27, seventh round)

The owner sliced a plate of the six heads with the card's supports in Bambu Studio (`6_pieces - A1 mini.gcode.3mf`, angle 30) and sent it back. Read against Bambu's own slice of the same heads
(`tree_slimsupports.gcode.3mf`, tree slim, its own supports), feature by feature, in mm of path (Bambu's own / the card's):

| head | Overhang wall | Bridge | Support interface | Support transition | Support |
|---|---|---|---|---|---|
| Base | 66 / 64 | 396 / 412 | 777 / 386 | 528 / 386 | 2128 / 1449 |
| Circular | 44 / **167** | 216 / 222 | 279 / 123 | 189 / 87 | 2427 / 720 |
| Negative Sphere | 95 / **176** | 303 / 242 | 479 / 166 | 338 / 152 | 2353 / 1300 |
| Negative Sphere2 | 84 / **165** | 261 / 227 | 437 / 129 | 304 / 137 | 3039 / 1323 |
| Oblique | 187 / 203 | 208 / 228 | 851 / 646 | 469 / 300 | 2923 / 1429 |
| Sphere | 40 / **117** | 216 / 223 | 198 / 65 | 110 / 44 | 1432 / 700 |

(the interface and transition columns are what the slicer types our plate lines as - it re-types them by geometry - and are not a coverage figure). The one that is: **Overhang wall**, the model's own perimeters printed
over air. Base and Oblique match; the four heads with a dome or a cavity have two to four times Bambu's, at the layers over the dome's flank (the Circular at z 10 - 11: 101 mm against 1) and over the cavity's apex (the Negative Sphere2 at z 14: 62 against 0).

**Why: the card's angle is not Bambu's.** The card reads its angle as the surface's tilt from flat, and the owner ran 30; the docs (section 0a of SUPPORTS-CARD.md) had it that Bambu's 30 means the same. Reading every support
line of Bambu's slice (the tips' own base lines, not only the interface and the transition) under the part's down-facing cells by tilt, Bambu holds: a dome 98 - 100 % to 35 deg, **79 - 83 % at 35 - 40, 35 - 42 % at 40 - 45, 3 - 14 % at 45 - 50, nothing beyond**.
Its threshold of 30 is a cut at about 42 deg of tilt from flat (the support's own expansion carries it past the 30 / 60 the slope arithmetic gives, and the base lines fill what the tips' sheet does not).
The card at 30 reaches 30. **At 40 the card holds at least what Bambu holds in every band to 45 deg** (the card at 40, all of Bambu's support lines, both dilated 0.5 mm; the share of the surface held at 20 - 30 / 30 - 35 / 35 - 40 / 40 - 45 deg, the card then Bambu):
Circular 100 / 100 / 100 / 99 against 100 / 98 / 79 / 35; Sphere 100 / 100 / 100 / 100 against 100 / 99 / 83 / 42; Negative Sphere 100 / 100 / 100 / 100 against 89 / 41 / 23 / 40; Negative Sphere2 100 / 100 / 100 / 84 against 98 / 82 / 60 / 12.
The card holds a little more than Bambu from 40 to 45 deg (its stair at the footprint's edge), which is the safe side.
The card's default stays 35 (its plan hashes and counts are pinned there) and its label still says Bambu 30; **40 is the setting that reads like Bambu's 30**.

**What the 38 - 40 deg builds broke, and the fix.** At 38 deg and over the Negative Sphere2's three flat patches, its cavity's wall and its apex are one footprint that rises 5 mm; its plate was built (11 layers) and then thrown away by the plate's own check against the part (`dmin`
0.1796 against the gap 0.18): the bead's downhill edge on a 20 deg slope stands 0.04 mm lower than the cell's centre that the stack's gap was read for. The footprint then went the ordinary way and the flat face held 28 %.
`gapAt` now counts the bead's half width on the slope (`gap / cos + (width / 2 + 0.03) * slope`): 81 % at 36, 38 and 40 deg alike. `support:coverage` section 4 holds the plate at 40 (floors Base 85, Circular 85, Sphere 88, Negative Sphere 68, Negative Sphere2 52, Oblique 85).

**A layer too low (the owner's slice at 40 deg).** The first version of that fix also added a flat 0.03 mm, and the stack's layer index is read as `floor((surface - gap - A) / layer)` with `A` the lowest tip's height less the gap: the lowest flat sits *exactly* on a layer's edge, so any excess - that 0.03, or float32 noise of 1e-8 mm in the height map's `S` and `gapAt` - dropped the whole flat a layer. At 40 deg the Negative Sphere2's three flat patches were laid 0.2 mm lower (a gap of 0.38 mm, not 0.18), and Bambu's slicer, which types a line as interface by its distance under the part, called the plate plain *Support* (the owner saw "an entire interface missing"). The flat 0.03 is gone and the index takes 1e-4 of a layer of slack (`+ 1e-4`, not `+ 1e-9`); the plate now stands at the same height at 30 and at 40.

**The zigzag of a narrow patch (the owner's reslice of supp_ref at 30).** Bambu's interface and transition layers over the Negative Sphere2's three flat patches are lines across each patch, turned layer to layer - the crosshatch whose air between lines keeps layers from welding. Ours were an outline loop and a small ring with a bare slit inside: a patch 2.3 mm across has 0.6 mm of border on each side (the outline's centre, then a pitch to the first line), leaving a band too narrow for the lines (`HATCH_MIN_SHARE` gave it up for concentric loops). `plateOfRegionCore` now has a middle way: when the outline-and-hatch does not fit, and the region is 2 mm across somewhere (`EDGE_HATCH_HALF_MM`), its lines are laid edge to edge (a line's half in from the edge, no outline) when there are three or more and they hold 30 % of it (`EDGE_HATCH_SHARE`); a strip a line or two wide stays one bead along it. The lattice is the same one, so the lines still alternate 45 / 135 and stack on the layer below. The three patches: Negative Sphere2 plate 30356 -> 24332 triangles (lines where the loops were); `support:coverage` 75 -> 73 % there. The slicer's border ring round each patch is not reproduced (an outline and the lines cannot touch in our extrusion); `support:region` section 9 holds the zigzag.

**Left.** The Sphere's and the Circular's flat 0 - 20 deg (85 / 93 % against Bambu's 99): the pole's last millimetre inside the innermost loop, too small for a bead; the Negative Sphere2's patches' tails (section 11).
**Not measured here:** Bambu's overhang-wall mm on a slice of the card's supports at 40 - there is no Bambu Studio in this box; the slice above is the owner's. A slice at 40 would settle whether the dome heads' overhang wall comes down to Bambu's.
