# Support interface: the sheet a tree carries under the part

`nso_support_interface.js` `sheet()`, built by `nso_support_gridpack.js`
`parts(plan, { interface: true })` - which is how the Supports card builds
(`app-supports-card.js`, `PARTS_OPTS`). Gate: `npm run support:interface`
(`tools/nso_support_sheet_check.js`); `npm run support:interface-export`
also writes the clamp with its supports to
`tools/support-interface-out/clamp_body_sheet.3mf`, and `npm run
support:print-export` the 2026-10-20 coupon (`fixtures/supports/top_clip_x2_coupon.stl`)
as the card builds it to `tools/supports-print-out/` (both git-ignored).
`node tools/nso_slicer_audit.js --sheet sliced.gcode.3mf` reads a slicer's
g-code of an export back: how each sheet line was printed (section 5).

## 1. The gap it closes

Every tree tip ended ON the part, 3 mm from the next, with nothing between:
the part's first ceiling layer had to bridge tip to tip in mid-air.
`finish()` (the per-tip 2 x 2 patch, `tree:interface`) existed but was in no
build and its patches are islands.

## 2. The reference

`clamp_body.stl` (`fixtures/supports/`), stood on its 94 mm axis and sliced in
Bambu Studio: tree(auto) / Tree Slim, 0.2 mm layers, threshold 30 deg,
branch_distance 5, interface_spacing 0.5, top_z_distance 0.2. Under the main
ceiling (z 72, about 45 x 40 mm), bottom to top (`; FEATURE:` / `; Z_HEIGHT:`
of `Metadata/plate_1.gcode`):

| what | z | lines |
| --- | --- | --- |
| branches | to 70.68 | 54 tips, nearest-neighbour spacing median 3.8, p95 5.7, max 6.3 mm |
| transition | 70.96, 71.24 | one direction (along y), 0.84 mm pitch, ~1.9 m extruded each, one serpentine |
| interface | 71.52 (along x), 71.80 (along y) | 0.84 mm pitch, one direction per layer |
| gap | 71.80 -> 72.00 | the part's first layer (72.20) prints as Bridge over the interface |

The same four layers and gap under the z 80 ceiling.

## 3. What is built, at every tip that meets the part

```
   z (clamp area 1)  what                                        slicer layer (0.2 mm) it lands in
   72.000            the part's underside
   71.820 - 72.000   air, 0.180 mm (true minimum distance)        71.8-72.0: empty
   71.620 - 71.820   I2  interface: loop + serpentine along A     71.6-71.8
   71.420 - 71.620   I1  interface: loop + serpentine along B     71.4-71.6
   71.220 - 71.420   T2  transition: T1 again                     71.2-71.4
   71.020 - 71.220   T1  transition: loop + serpentine along A    71.0-71.2
   71.020            z_cap: every cap's flat top, every capless tip's cut
   69.020 - 71.020   every tip's flat CAP, 2 mm of rise           ... 70.8-71.0
```

Each of the four layers is **one closed perimeter loop round the sheet's
footprint, then one serpentine inside it** - line, U-turn, line ... at a 0.84
mm pitch - its turns joined to the loop, the whole layer one connected thin
wall. T1, T2 and I2 are the same; I1 runs across them in the same loop. That is
Bambu's own tree on the same coupon (`thinwall_sideXside.gcode.3mf`, tree
slim): every layer at z 12.58 / 12.86 / 13.13 / 13.40 opens with its loop,
22.24 x 14.34 mm, then 13.6 mm lines with 0.84 mm turns (I1: across), 29 / 29
/ 21 / 29 lines a layer counting the loop's two sides. The owner printed the
loops alone, by accident, and they released cleanly: **the loop is what the
sheet releases by**, not decoration.

**supports-print-1 (the 2026-10-20 print), and its correction.** The coupon
printed with our first supports came out clean and the sheet released, but the
trees wobbled when the sheet started, the transition layers sagged between tips
3 mm apart, and half the interface welded to the part. The first answer here
was two interface layers of separate straight lines lying on caps that rose
0.01 mm into I1; the print showed what was wrong with that - the caps' walls
printed in the same layers as the lines, and every line was an island. So now:

- **Nothing but the sheet occupies the sheet's layers.** Every cap ends at one
  level, **z_cap**, one full layer under T1: the cap's flat top, and a
  capless tip's flat cut, is z_cap exactly, and T1's underside is z_cap. The
  two meet on that plane, no overlap, so no slicer layer through T1 cuts a cap
  (`support:interface` 1b and 4, measured on the parts built). The layers
  above stand each on the one below the same way: T2 is T1, and set
  0.002 mm into it their walls stood in one plane for 2 um, which the union
  left as slivers (2 piercing pairs on the clamp's area 1). For the weld
  alone (the reference path; the card does not weld), T1's underside goes
  0.015 mm into the caps (`SHEET_SINK_MM`): on one plane, where a T1 wall met a
  cap's top, the union left a T-junction it read as piercing (2 pairs on the
  clamp's area 2); sunk, it cuts the caps' upright top band. The parts, and so
  the export and every slice, keep z_cap exact.
- **A loop and a serpentine each piece, each layer.** The sheet lies on a grid
  at the pitch both ways in its frame (A along T's lines, B across). Each
  piece of it has ONE loop round its outline - a rectangle, or a stepped
  rectilinear outline, as Bambu's loops follow the region, not a bounding box
  - and ONE serpentine inside it whose lines run from one side of the loop to
  the other and whose turns are walked along the loop (the loop's own segments:
  Bambu draws its turns 0.36 mm in from its loop's middle, inside the bead -
  the same solid). A piece with a hole (a ring round a boss) has the hole's
  outline joined to its loop by a slit along its own inner edges: still one
  closed loop. Loop and serpentine go through `NSO_RasterLines.extrudeFlat` as
  one graph; the channels between the lines are closed at both ends, so a
  piece's section is ONE region whose holes are the channels and whose outer
  boundary is its loop, one bead wide (`support:interface` 1c, measured on the
  parts built).
- **The pieces.** The field is every cap of the level dilated by 1.25 mm
  (`FIELD_MM`: caps 2 mm apart meet in it), inside the footprint (below), out
  of another level's cells. A grid cell is the sheet's when its four edges lie
  in the field; runs of cells shorter than 2 mm either way go (every channel is
  2 mm or longer; a rung between two of an outline's walls may be one pitch),
  and so does a cell meeting another only at a corner. Each 4-connected set
  left that carries two caps or more is a piece. **A piece whose largest
  rectangle carries every cap it does is that rectangle** - the coupon's slab:
  one, 21.84 x 14.28 mm - else its outline is stepped (the clamp's rings).
  **No line ends in mid-air**: every line ends on its piece's loop.
- **Caps spread before they narrow**: legs that lean to one node cross z_cap
  closer than their tips stand (the coupon's slab: caps 2.11 mm wide where
  they crossed), so two caps nearer than their widths allow first slide apart,
  each within its slack (its top still over its column's end), checked where
  they land - the slab's caps are 2.50 mm.
- **Caps** (`THE CAPS` in the file's header). Every tip under a sheet ends in
  a round flat cap that follows its own leg: a frustum from where the leg's
  axis crosses 2 mm (`CAP_RISE_MM`) under z_cap - 0.9 of the column's side
  across there, inside its square however it is turned - up to where it
  crosses z_cap, its last 0.02 mm upright (`CAP_BAND_MM`: a flank cut 10 um
  from its top came back from the union as needles NSO's slicer could not
  close). The column is cut along its own axis just under the cap's top, its
  end inside the cap's height (the rise is never shorter than that needs: a
  3 mm strut's cap rises 2.32 mm); the end's corners may stand out of the
  cap's flank, where the column stood before.
  A cap is as wide as its nearest neighbour allows less 0.5 mm
  (`CAP_SPACE_MM`), held to 2.5-4 mm (`CAP_MIN_MM` - `CAP_MAX_MM`). Where it
  would come nearer the piece than the gap, or near another tree's column, it
  is first slid off (by at most its top's radius less the column's half
  diagonal), then narrowed by 0.25 mm steps, down to the column's side -
  where the tip has no cap and is cut flat at z_cap, said per tip.
  Those clearances are sampled; then every cap is **measured** against the
  piece with the exact triangle distance and narrowed until it keeps the gap.
  **Caps never overlap**: two caps still nearer than their widths allow are held
  0.05 mm (`CAP_PART_MM`) apart, the narrower keeping its width - and so are
  a cap and a neighbour's bare column top, and caps of neighbouring levels.
  Tips closer than 2.55 mm get caps under 2.5 mm (section 4).
- **The line width is 0.43** (one bead and `SHEET_OVER_MM` 0.01, at a 0.4
  nozzle), section 5; `sheetWidthMm` sets another (the width matrix).
- **The feet**: one shared first-layer pad per cluster of trunks, the trees on
  one pad one support (docs/SUPPORT-GRIDPACK.md, *Feet*).
- **The gap stays 0.18.**

**The level.** A tip's sheet top is 0.18 mm under the lowest ceiling over its
cell (a point more than a layer below the tip is a lip or a wall, left to the
footprint). Tips that agree within 0.01 mm are one level: one sheet, however
many trunks they belong to. Weld joins it to every trunk carrying one of its
tips, and `shells()` groups it with them, so the region's tree and its sheet
export as one object.

**The footprint.** A cell is free where the stack's column, from 0.18 below
its base to 0.18 above its top, meets nothing of the piece within 0.18 + half
a line: vertical rays for ceilings and ledges, horizontal row rays for the
inside of a wall, which a vertical ray runs parallel to and never sees. No
other support's column passes through it (as planned, and as it will be cut;
a member of a tree this level carries that stays under z_cap is under the
stack, not in it). Each cell belongs to the nearest sheet tip within 0.6 tip
spacings - how another level's cells are known. The gap is then measured on the stack with the exact triangle distance and the
level lowered (a sloped ceiling) or cleared round the point (a wall) until it
is 0.18.

**The angle is chosen.** Of the candidates (0, 90, and the 1:2 and 1:1
diagonals) the sheet takes the direction A whose pieces leave the fewest caps
with no T line on them, then has the fewest pieces, then the fewest that are
not rectangles, then the most sheet (in 5 % bands), then the shorter line (A
across a rectangle's short side, as Bambu's), then the axes. The coupon's area
1: 90 deg, as Bambu's.

**The tips the sheet does not carry.**

| tip | what it gets |
| --- | --- |
| under a sheet | its cap, T1 lying on it, its top z_cap |
| under a sheet, no room for a cap (the piece or another tree's column too near) | cut flat at z_cap |
| under a sheet but no T line lies on its cap (beside a wall, on no piece) | cut at z_cap all the same if a line passes over it; carries nothing |
| no line of any sheet reaches it, or its level has no sheet (one tip, a one-row band, no room above the foot) | cut at the gap line, standing beside the sheet, not under it: its own flat top 0.18 mm under the part (finish()'s last rung), lowered until its own solid keeps the gap |
| a side tip (a face more than 30 deg off level) | drawn back along its stub until its own solid keeps the gap (unchanged) |

`finish()` and its 1.2 mm per-tip patches are unchanged and keep
`tree:interface`.

## 4. Measured (`support:interface`, 131 checks)

The clamp at the card's defaults has four areas. Every flat ceiling carries a
sheet, a piece at a time:

| area | ceiling | tips carried / under a sheet / cut at the gap / side | pieces | lines T / I1 | caps (at 2.5-4 mm), widths |
| --- | --- | --- | --- | --- | --- |
| 1 | z 72 flat (+ 45 deg chamfer 62-71, fillet 72-75) | 172 / 176 / 14 / 69 | one stepped outline, 57.12 x 57.96 mm, its ring round the boss joined by a slit | 95 / 96, 45 deg | 167 (142), 2.13-2.50 |
| 2 | z 80 flat (a ring round the boss) | 45 / 45 / 0 / 0 | one stepped outline, 22.68 x 20.16 mm, its ring joined by a slit | 43 / 42, 63.43 deg | 37 (1), 1.29-2.50 |
| 3 | z 0.8-2.0 (the bottom fillet, over the plate) | 0 / 0 / 0 / 27 | - | - | none: every tip is a side tip |
| 4 | z 86 ridge | 3 / 3 / 0 / 0 | one rectangle, 8.40 x 3.36 mm | 9 / 3, 0 deg | 3 (3), 2.50 |

`support:interface` holds the clamp's coverage: area 1 at least 161 tips
carried, area 2 at least 34 - what one serpentine a level carried; one
rectangle a level carried 84 and 14. Area 1's 14 tips cut at the gap sit on
two small levels (z 72.0) no piece of 2 mm lines fits.

The coupon (`top_clip_x2`): area 1, the slab at z 13.5, 40 tips, 40 caps of
2.50 mm, a 21.84 x 14.28 mm loop (Bambu's: 22.24 x 14.34) with 25 lines of
14.28 mm at 90 deg in T1, T2 and I2 and 16 of 21.84 mm at 0 deg in I1; area 2,
the leg at z 6.5, 9 tips 1.8 mm apart, 9 caps of 1.66-1.78 mm (left as they
are for this print), one rectangle, 13.44 x 2.52 mm, its T lines across the
short side (15 of 2.52 mm). Each area one rectangle. One support (one pad
under both areas' trees) built in about 1.5-2 s.

**Caps under 2.5 mm**: where tips stand under 2.55 mm apart even after the
caps spread (the clamp's area 2, the coupon's leg, the tab) the caps are held
0.05 mm apart, so they come out narrower - every one says why; nearest-neighbour
gaps edge to edge 0.05-0.84 mm, never over 2 mm.

- **Gap**, exact triangle-to-triangle distance over the whole interface zone
  (the sheet, the caps, every tip, 3 mm under the lowest contact):
  **0.180000 mm** on every sheet area, 0.183583 mm on area 3 (side tips
  only); the coupon too.
- **Stack**: T1, T2, I1, I2, each one 0.2 mm layer, T1 on z_cap, the top 0.18
  mm under the ceiling; every cap's flat top exactly z_cap, measured on the
  parts built.
- **Layers**: every piece a closed loop and one serpentine inside it, turns on
  the loop, T2 and I2 T1's; every layer's mid-layer section one region a piece:
  a rectangle's outline 0.000 mm off a rectangle the loop's size and a bead,
  the loop 0.430 mm wide on all four sides; a stepped outline's edges on the
  axes (under 2e-5) and its area the loop's polygon grown half a bead all
  round (the clamp's area 1: 1863.77 mm2 against 1863.77). Lines: a
  rectangle's 2 mm or longer, an outline's rungs 1.68 mm at the least. One
  direction per layer (share 1.000 on the serpentine's lines), pitch 0.840.
- **NSO's slicer**: every layer in closed paths, the shortest 3.3 mm (the
  clamp's area 1) - the outline's loop and one round each channel, about two
  passes over each line. It has no thin-wall mode; printing a layer in one
  pass is a slicer ticket (`nso_slicer.js`), not this one.
- **Nothing above z_cap but the sheet** under any of its paths.
- **Feet**: one pad per cluster, none split; pads 0.28 mm or more from the
  part. Below the zone the trunks are the planner's: area 1's nearest is
  0.1776 mm from the part, with and without the sheet (pre-existing: rails are
  kept 0.2 mm off on rays).
- **Solids** closed, manifold, no degenerate triangle, **no piercing pair in
  any sheet**. The trees and pads below carry their own (area 1: 464 piercing
  pairs, 1037 without the sheet).

**Build time, the card in Chromium** (`GENERATE`; detecting / planning /
building in the worker; measured with the four-layer sheet, before
supports-print-1). Before shells the sheet's areas were welded in the
worker and the rest on the page; now nothing is welded - every part is its own
closed shell (`NSO_SupportGridpack.shells`, `support:shells`):

| piece | | total | planning | building | welding |
| --- | --- | --- | --- | --- | --- |
| clamp, standing (4 areas) | welded | 23-27 s | 3.4 s | 3.1 s | 16 s |
| | shells | **7.6-8.9 s** | 3.5 s | 3.0 s | - |
| the wedge, `v9_mirror_factory` (25 areas) | welded | 23.6 s | 4.4 s | 4.7 s | 13.2 s |
| | shells | **11.9 s** | not split | not split | - |

**Where the clamp's weld went** (node, the four-layer sheet; area 1: 126 trunks and its sheet, 19 s of
the 22 s over the four areas): 584 unions, 14.1 s - and two thirds of that
(9.6 s) was not the boolean but what every union pays around it: the two soups
pre-welded (`weldSoupVerts` 3.1 s, `NSO_weldEpsFor` 0.8 s), turned into
manifolds (4.1 s) and censused (`NSO_manifoldStats` 1.6 s), the growing trunk
re-sent each time. By stage: the trunks' folds 5.4 s (446 unions), the rounds
that join touching trunks 5.5 s (136), the sheet's four layers folded 0.9 s
(the layers sit EPS into one another: 0.7 s of kernel for 6k triangles), the
sheet joined to every trunk under it 2.3 s (130k + 56k triangles),
`_finishUnion` 1.8 s. The exact-distance gap check is not in it: it runs in
the sheet's planning (building), 0.18 s of that step's 3.3 s; the step is the
gap solve rebuilding the level's footprint raster (2.45 s, three passes).

The weld bought nothing a slicer prints: `support:shells` cuts both at every
0.2 mm layer with NSO's slicer and the sections are the same, island for
island, to under two microns (1.42 um at worst, the wedge's foot layer: the weld's own pre-weld is the difference). And the
welded solid was not one clean shell either: area 1's had 6809 piercing pairs
inside it, where unions that closed a sliver of void read as "did not touch"
and left trunks overlapping.

The sheet's tips are counted while the sheet is planned (`sheet()`'s
`opts.progress`), so building moves from its first second; before, it sat at 0
through the sheet - 78 % of the clamp's building - and counted only the trunks.

`support:interface` (`tools/nso_support_sheet_check.js`) still builds with the
weld, as `solid()` does, and holds the card's path beside it on the coupon
(footPads 'shared', shells, shareFeet: under 10 s, one support, one pad).
`support:shells` holds every layer of the shells to the weld's.

## 5. The line as printed (supports-print-1, step 3)

`slice_w_supports.gcode.3mf` (Bambu Studio slicing our 2026-10-20 export)
printed each 0.84-pitch sheet line as ~0.2 mm segments at about twice the
bead, and NSO's own slice of the export showed the lines in short pieces with
holes between them. Both start in the geometry: the line was 0.42 mm, exactly
one bead (`NSO_Thickness.floorFor(0.4)`), and a slicer insets a region by half
a bead for its outer wall - a 0.42 line is a **zero-width wall**.

- **NSO's slicer** (Clipper2, offset -w/2): keeps none of an isolated 0.42
  line; on the export, 16-20 % of a line crossing tip columns survives, on the
  corners the union left - the short pieces in the screenshot. From 0.4225 up
  every line is one unbroken pass.
- **Bambu Studio** (classic walls, thin walls off): a 0.42 strip is printed
  as a loop round a sliver - out and back, two passes - cut into 0.02-0.35 mm
  pieces wherever its overhang speed grade changes. Every line of that slice
  was printed (52 of 52 in each layer, registered to the export: Bambu set
  the plate 0.42 mm off it in x; read unregistered, two 22 mm lines looked
  missing, which an earlier version of this page took at its word). With
  `detect_thin_wall` on, a line is one medial-axis pass at its width + 0.043.

So the line is **0.43 mm** (`SHEET_OVER_MM` 0.01 over the bead), and each
layer is **a loop and a serpentine** (section 3). NSO's slicer has no thin-wall
mode: it draws a 0.43 wall as a closed loop round its sliver - the outline's,
and one round each closed channel - so the coupon's slab prints in 27 closed
paths a transition layer (18 in I1), every one 30 mm or longer, two passes
over each line (`support:interface` 1d). Under a bead (0.40, 0.36, 0.30) it
draws nothing.

**The width matrix.** One pass per line in Bambu takes its thin-wall
detection, and a strip under a bead to detect. `npm run support:print-export`
writes, beside the card's export and its `_thinwall` A/B file, the coupon with
the sheet's lines 0.40 / 0.36 / 0.30 mm wide (`sheetWidthMm`) and
`detect_thin_wall = 1` on the support objects only:
`top_clip_x2_supports_w040_thinwall.3mf`, `_w036_`, `_w030_`. The layers are
the same (the slab: a 21.84 x 14.28 loop, 25 / 25 / 16 / 25 lines inside it,
40 caps of 2.50 mm). The card exports 0.43 and does not set thin walls, and
stays so until the width matrix says otherwise (the owner's call). In the owner's
`thinwall_sideXside.gcode.3mf` (thin walls off in its settings) the 0.43
lines of the earlier export printed as 2.00 passes, and Bambu's own tree's
layers as one pass at 1.30 x the outer wall's E/mm.

**Reading a slice back**: `node tools/nso_slicer_audit.js --sheet
sliced.gcode.3mf [--export the.3mf]` reports, per sheet layer of each support
object, the segments, their mean and median length, the share of the toolpath
in segments of 2 mm or more, E/mm and its ratio to the file's own outer wall,
the passes per line (a loop round a sliver reads 2), the E per mm of LINE
(ratio x passes), and with `--export` each sheet line of the export printed or
missing. Target: E per mm of line 1.00 +- 0.15 of the outer wall's, 90 % of the
toolpath in segments of 2 mm or more. `support:audit` holds it (section 5).

| slice | layer | segments | mean | in >= 2 mm | E/mm vs wall | passes | per mm of line |
| --- | --- | --- | --- | --- | --- | --- | --- |
| our 2026-10-20 export | z 13.00 | 2644 | 0.22 mm | 1 % | 0.92 | 2.00 | 1.84 x |
| | z 13.20 | 2873 | 0.21 mm | 1 % | 0.91 | 1.94 | 1.77 x |
| | z 13.40 | 2850 | 0.20 mm | 1 % | 0.91 | 1.99 | 1.81 x |
| Bambu's own interface (same file) | z 13.20 | 59 | 6.31 mm | 90 % | 1.00 | - | - |

## 6. Not done here

- MAX_SPAN_MM stays 3.29 (tips at 3 mm on the beacon grid). Opening the
  pitch to the reference's 3.8-5.7 is a follow-up once the sheet has printed.
- No detection change (`nso_support_aim.js` untouched): the 45 deg chamfer
  under the clamp's ceiling is detected at the card's 60 deg and held by side
  tips; Bambu at 30 deg leaves it.
- Sloped and curved ceilings get no stair-stepped sheet: a tip on one is a
  level of its own, usually too narrow for a sheet, and is cut at the gap.
- G-scope's support row builds as before (no `interface`).
