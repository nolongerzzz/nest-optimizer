# Support footprint: the beacons' outline is the surface's own edge (supports-footprint)

`nso_support_beacons.js` (`region.footprint`, `opts.insetMm`, `opts.footprint`), `nso_support_interface.js`
(`opts.perimeter`: the sheet's outline), `nso_support_gridpack.js` (`opts.sheetPerimeter`), the Supports card's outline and
click test (`app-supports-card.js`). Gate: `npm run support:footprint` (`tools/nso_support_footprint_check.js`, ~1.5 min;
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

**The card** draws the area's loops (a ribbon on the inside of each, on the surface: the plane of the spot nearest the segment) and tests a
click against them: the ray meets the plane of one of the area's spots and the point is inside the loops
(`inFootprint`, even-odd). A spot the footprint does not hold (a crease, a tip, a side spot, one placed by hand, an area a
build split) keeps its cell, as it was.

## 4. Measured (`support:footprint`)

The six heads, the card's one-trunk Auto (Dense, spots 1 mm in, the sheet's outline on) against the same build as it was; the
sheet's top faces, and the share that lies outside the part's plan:

| head | flat faces of the stack and caps, mm2 | outside the part's plan, now | farthest out | as it was |
|---|---|---|---|---|
| Base | 770 | 17.9 (2 %) | 0.90 mm | 18.7 of 576 (3 %) |
| Oblique | 154 | 9.9 (6 %) | 0.60 mm | the same (its stair is not changed) |
| Circular | 173 | 0.0 | - | the same |
| Sphere | 192 | 0.0 | - | the same |
| Negative Sphere | 1623 | 163 (10 %) | 1.20 mm | 529 of 2009 (26 %) |
| Negative Sphere2 | 303 | 63 (21 %) | 1.10 mm | 161 of 393 (41 %) |
| **all six** | 3214 | **254 (8 %)** | 1.20 mm | 718 of 3400 (21 %) |

(the "flat faces" count every layer of the stack and the caps' top discs, so a head with several levels counts a surface several times.) What the
table does not show is the card: the outline of each of those areas is the footprint of section 3, the Base's is the diamond's own edge where it was
20 cells hanging 41 % over the air, and a click is read against it. The Base's remaining 18 mm2 is one corner tip too near the diamond's rounded
corner for a sheet of its own (section 6); the Negative Spheres' is rims narrower than the sheet's 2 mm lines. `support:onetrunk` (the six built
the card's way, 19 gates) holds: one trunk each, every spot held, 0.18 mm of gap and 0.35 mm sideways everywhere.

## 5. Defaults: what is on, and where

Everything here is **asked for**; the engine's defaults are the claude-wip's, byte for byte (the planner suites pin the spots
where the grid put them and the sheets' bytes):

| | default | the card |
|---|---|---|
| `detect` `footprint` | off (no field is added to a region) | on, through `insetMm` |
| `detect` `insetMm` | 0 (the spots stay where the grid put them) | 1 mm (`detectOverhangs` `beaconInsetMm`) |
| `sheet` `perimeter` | off | on (`PARTS_OPTS.sheetPerimeter`) |

`tools/nso_supports_print_export.js` `build(piece, partsOver, name, one, outline)` takes the card's two as its fifth argument;
`support:onetrunk` and `support:footprint` use it.

## 6. Not done, and named

- **The sheet is not the whole footprint.** The Base's sheet covers ~67 % of the footprint (its rectilinear pieces and the
  caps' field do not reach the diamond's corners); Bambu's interface fills it. This ticket keeps the sheet *on* the part, it does
  not make it fill the part. A coverage ticket would grow the field to the footprint's loops.
- **A rim thinner than the sheet's 2 mm lines** (Negative Sphere2's corner patches are 2.5 x 3.3 mm) still gets a sheet that
  reaches out past the edge: the least that makes one (up to 1.2 mm, the card's lines cannot be shorter). The gate allows it.
- **A stair** (Oblique's) is laid by its own code and is not held to the outline; its tips stay on the grid, four of them 0.14 mm from the
  plane's diagonal edge (the stair's strips keep to the part's outline themselves: `STAIR_REACH_MM`).
- **A tip too near a corner for a sheet of its own** (Base's left corner: the diamond's rounded corner, 2.3 mm across 1 mm in) gets the
  least piece that fits, reaching up to 0.9 mm past the edge. A better answer is to hold it from the main sheet's field; not done.
- **A dome's footprint** has four small spikes at its rim (Circular): the surface's angle crosses the limit between two facets.
- **The Negative Spheres' apex** (Bambu's second surface) is not detected, so it has no footprint.
- **An area a build split** (held in part, the lost spots an area of their own) draws the first part's whole outline and the
  rest in cells.
- **Hand-placed spots** (Shift-click) and the G-scope's markers (`app-gscope-support.js`) keep what they had: no footprint is asked for there.

## 7. What else moved (re-pinned, with the reason)

- `support:onetrunk` builds the six heads **the card's way** now (`PE.build(..., outline = true)`; `--as-it-was` for the old build): its 19 gates hold.
- `support:plate` section 6: Negative Sphere2's single-piece Generate is 9788 triangles (632cd214c51c, 12532 before), sha `a5af748eaf65` - its three
  sheets keep to the rim; Circular and Sphere are the bytes they were (the outline changes nothing under a dome that it did not already hold). Stable over
  two runs.
- `support:workflow` section 1: the area's outline is "a handful of segments, the face's own edge" (`view().areas[].outlineEdges`) where it was the
  44 edges of the 12 x 10 cells; section 7: the tunnel ceiling's spots by the mouths 28 held / 68 unreachable (24 / 72): the card moves the ceiling's spots
  0.5 mm from the bore's walls and the mouths' edge in to 1 mm, and the planner's lean limit is a sharp cutoff. The 96 spots are the same 96.
- Everything with the options off is byte for byte what it was: `support:index` (its plan hash is why `footprint` is only added when asked),
  `support:everywhere` (its fixture hashes), `support:feed`, `support:gridpack`, `support:exposed`, `support:interface-fixtures`,
  `support:shells-coupon`, `tree:interface`, `slicer:supports`, `slicer:brim` all pass unchanged.
