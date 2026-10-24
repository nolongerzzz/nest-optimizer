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
footprint, then one serpentine inside it** - line, U-turn, line ... at a
0.84 mm pitch - its turns standing in from the loop, never touching it, and
the serpentine joined to the loop at ONE point, its start: one connected thin
wall, one path a layer, as Bambu's (54 extrusions, 3 travels). T1, T2 and I2
are the same; I1
runs across them in the same loop. That is
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
- **A loop and, apart from it, a serpentine each piece, each layer.** The sheet
  lies on a grid at the pitch both ways in its frame (A along T's lines, B
  across). Each piece has ONE loop round its outline - a rectangle, or a
  stepped rectilinear outline, as Bambu's loops follow the region - and ONE
  serpentine on the piece's inner grid points (a point all four of whose cells
  are the piece's), so every line and turn of it stands a pitch off the loop: a
  clear gap of 0.44 mm at the 0.40 line, a line width and more (0.41 at the
  earlier 0.43; Bambu's turns stand 0.36 mm in from its loop). **The turns
  never touch the loop.** With them on it (this branch's first build) loop
  and lines fused into one region with every channel closed and a slicer
  traced every channel - each line twice: on the owner's plate
  (`thinwall_supports_bambu.gcode.3mf`) our layers printed 610-856 mm in
  1,350-2,700 segments, Bambu's 434 mm in 54.
- **The bridge: one point.** The serpentine starts one pitch from a loop
  vertex (its first line's end, on an inner point); a one-pitch stub from that
  vertex to it joins the two (`bridged`; where only the serpentine's far end
  sits by the loop it runs reversed). Everywhere else the gap stays.
  A layer's section is then exactly ONE region a piece - loop, stub and
  serpentine - with ONE hole, the loop's inside less the serpentine
  (`support:interface` 1c, measured on the parts built): one connected thin
  wall, one slicer path a layer, as Bambu's.
- **The pieces.** The field is every cap of the level dilated by 1.25 mm
  (`FIELD_MM`: caps 2 mm apart meet in it), inside the footprint (below), out
  of another level's cells. A grid cell is the sheet's when its four edges lie
  in the field; runs of cells shorter than 2 mm either way go, and so does a
  cell meeting another only at a corner; each 4-connected set left is a piece
  of the field. **It is its largest rectangle where that carries as many caps
  as its strips do** - the coupon's slab (21.84 x 14.28 mm) and leg (2.52 x
  13.44 mm), one each - else its column strips: where a column splits round a
  hole or two meet, the strips end and that column goes (a pitch between two
  loops), so the clamp's ring round its boss is four strips, each its own loop
  and serpentine. A cap is carried when a wall of T1, loop or serpentine,
  either way, lies across it with its whole width on it.
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
- **The line width is 0.40** (`SHEET_UNDER` 0.95 of the 0.42 bead, to the
  0.01 mm, at a 0.4 nozzle), section 5, printed by the slicer's thin-wall
  pass: every support object carries `wall_generator = classic` and
  `detect_thin_wall = 1` (the support set: docs/BAMBU-PROJECT-EXPORT.md);
  `sheetWidthMm` sets another width.
- **The feet**: one shared first-layer pad per cluster of trunks, the trees on
  one pad one support (docs/SUPPORT-GRIDPACK.md, *Feet*); since supports-foot
  each trunk stands on a round trunk that widens going down, flared onto its
  pad, and the pad is drawn round the flare (docs/SUPPORT-GRIDPACK.md, *The
  trunk*). Nothing above the trunk changes.
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
with no T wall on them, then has the fewest pieces, then the fewest that are
not rectangles, then T's lines 2 mm or longer (a piece three cells across has
room for 0.84 mm lines one way only: T, three layers of four, takes the long
way, and I1 across it is short-lined, as Bambu's own I1 on the leg), then the
most sheet (in 5 % bands), then the shorter line (A across a rectangle's short
side, as Bambu's), then the axes. The coupon's area 1: 90 deg, as Bambu's.

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
sheet, a piece at a time. Measured at the card's 35 deg (since
supports-angle-default, docs/SUPPORTS-CARD.md 0a; at the old 60 area 1 also
took the 45 deg chamfer at z 62-71, 69 side tips, and area 3 had 27 spots):

| area | ceiling | tips carried / under a sheet / cut at the gap / side | pieces (each a loop and a serpentine) | lines T / I1 | caps (at 2.5-4 mm), widths |
| --- | --- | --- | --- | --- | --- |
| 1 | z 72 flat (+ fillet 72-72.7) | 176 / 176 / 14 / 0 | four pieces round the boss: rectangles 9.24 x 43.68 and 8.40 x 43.68, outlines 22.68 x 26.04 and 22.68 x 14.28 mm | 71 / 146, 0 deg | 176 (152), 2.13-2.50 |
| 2 | z 80 flat (a ring round the boss) | 45 / 45 / 0 / 0 | four strips, 5.0 x 16.8, 12.6 x 5.9, 12.6 x 11.8, 3.4 x 12.6 mm | 36 / 30, 63.43 deg | 37 (1), 1.29-2.50 |
| 3 | z 0.8 (the bottom fillet, over the plate) | 0 / 0 / 0 / 14 | - | - | none: every tip is a side tip |
| 4 | z 86 ridge | 3 / 3 / 0 / 0 | one rectangle, 3.36 x 8.40 mm | 3 / 9, 90 deg | 3 (3), 2.50 |

`support:interface` holds the clamp's coverage: area 1 at least 161 tips
carried, area 2 at least 34 - what one serpentine a level carried (one
rectangle a level carried 84 and 14). Area 1's 14 tips cut at the gap sit on
two small levels (z 72.0) no piece of 2 mm lines fits.

The coupon (`top_clip_x2`): area 1, the slab at z 13.5, 40 tips, 40 caps of
2.50 mm, a 21.84 x 14.28 mm loop (Bambu's: 22.24 x 14.34) with 25 lines of
14.28 mm at 90 deg in T1, T2 and I2 and 16 of 21.84 mm at 0 deg in I1; area 2,
the leg at z 6.5, 9 tips 1.8 mm apart, 9 caps of 1.66-1.78 mm (left as they
are for this print), one rectangle, 2.52 x 13.44 mm: T's two lines of 11.76 mm
along it, I1's 15 lines of 0.84 mm across (a piece three cells across has
room for no more; Bambu's own I1 on the leg is 55 % one way, 2.6 mm lines).
Each area one rectangle. One support (one pad
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
- **Layers**: every piece a closed loop and one serpentine a pitch inside it,
  touching it only at its start (the bridge; elsewhere 0.840 mm centre to
  centre, a 0.440 mm gap at 0.40), T2 and I2 T1's; every layer's mid-layer section ONE
  region a piece - its outline the loop's polygon grown half a bead (the
  coupon's slab: 22.240 x 14.680, within 0.1 mm), its one hole within the
  loop's polygon shrunk half a bead - and no region apart. One
  direction per layer (share 0.94-0.96 on the coupon's slab), pitch 0.840 (a
  line's two edges paired only across that layer's own material: the gap
  between two lines, 0.44 mm, is about a bead wide itself); a
  layer whose lines are under 2 mm on the whole (I1 on the coupon's leg and
  the clamp's ridge) is read from the plan, and says so.
- **NSO's slicer**: it has no thin-wall mode, so of a 0.40 sheet (under its
  0.42 outer wall) it draws nothing - no path, nothing broken off; a sheet a
  bead wide or more it draws in closed paths in its one region a piece, none
  under 2 mm (at 0.43: 2 paths a layer on the coupon's slab, 743.8 and
  72.3 mm, about 2.1 passes over each line). One pass is a slicer ticket
  (`nso_slicer.js`), not this one.
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

So the line was **0.43 mm**, a hair over the bead, until the width matrix
below settled it: the line is now **0.40 mm** (`SHEET_UNDER`: 0.95 of the
bead, 0.399 to the 0.01 mm; nozzle x 0.95 would be 0.38), printed by the
thin-wall pass. Each layer is **a loop and a serpentine joined at one point**
(section 3): one connected thin wall. The first build joined every turn to the loop; loop and
lines fused into one region with every channel closed, and on the owner's
plate (`thinwall_supports_bambu.gcode.3mf`) our layers printed 610-856 mm in
1,350-2,700 segments - each line twice - against Bambu's 434 mm in 54. NSO's
slicer has no thin-wall mode: it drew a 0.43 wall round its sliver - 2 closed
paths a layer on the coupon's slab, the outline's 743.8 mm and the hole's
72.3 mm, about 2.1 passes over each line - and under a bead (0.40) it draws
nothing (`support:interface` 1d). One pass is a slicer ticket.

**The width matrix, settled (2026-10-21).** The sheet's lines at 0.40 / 0.36
/ 0.30 mm with `detect_thin_wall = 1` on the supports were sliced on the
owner's A1 mini: with the **classic** wall generator and **Detect thin wall**
on (Strength > Walls), Bambu Studio prints a 0.40 line in **one pass** -
filament 1.09 m, against 1.03 m without the sheet and 1.14 m for the 0.43
sheet drawn round its sliver. So the card's line is 0.40, and every support
object carries both overrides, `SHEET.slicerSettings`, in
`Metadata/model_settings.config` (`nso-3mf.js` writes an object's `settings`
as its metadata, as Bambu saves a per-object override; the card puts them on
each support model, `buildPlacedObjects3MF` and the selected-model export
carry them): `wall_generator = classic` (Bambu's default is Arachne) and
`detect_thin_wall = 1`. In Bambu Studio's source both are per-object options
(`PrintObjectConfig::wall_generator`, `PrintRegionConfig::detect_thin_wall`);
the importer reads an object's metadata into its config for any vendor's 3MF
(`bbs_3mf.cpp`), and `Plater::load_files` resets it when the file comes in as
geometry only (File > Import / Add, or "Import geometry only" on a plate that
holds objects) - **open the export as a project**; the support object then
shows the override badge in the object list. Since export-bambu-project the
export IS Studio's project envelope (docs/BAMBU-PROJECT-EXPORT.md); the
support set is these two plus `sparse_infill_density = 0%` and
`wall_loops = 1` (no filler inside a trunk; top / bottom shells 0 were tried
and failed on the print, docs/BAMBU-PROJECT-EXPORT.md). `npm run support:print-export`
writes the coupon as the card exports it, `top_clip_x2_supports.3mf` (a
21.84 x 14.28 loop, the serpentine a pitch inside it joined at its start,
25 / 25 / 16 / 25 lines, 40 caps of 2.50 mm; the leg 2.52 x 13.44). In the owner's
`thinwall_sideXside.gcode.3mf` (thin walls off in its settings) the 0.43 lines
of an earlier export printed as 2.00 passes, and Bambu's own tree's layers as
one pass at 1.30 x the outer wall's E/mm.

**Why Bambu showed no interface at 0.40 / 0.36 / 0.30 at first** (2026-10-21,
read in Bambu Studio's source - `bbs_3mf.cpp`, `Plater.cpp`,
`PerimeterGenerator.cpp`; the owner's print since confirmed thin walls on
print a 0.40 line in one pass):
- The owner's process is classic walls with `detect_thin_wall = 0`. Classic,
  thin walls off, offsets each island in by half the outer wall, 0.21 mm at
  0.42: a 0.43 strip leaves a 0.01 sliver, drawn round out and back (807-814
  mm a sheet layer against Bambu's own 434), and a strip under 0.42 leaves
  nothing - no interface. `min_feature_size` and `min_bead_width` are
  Arachne's; with classic walls they do nothing.
- With thin walls on, classic takes the medial axis of whatever is narrower
  than a loop (from a third of the nozzle, 0.13 mm) and prints it in one pass
  at its width: the three files would print.
- The override is where Bambu reads it: `Metadata/model_settings.config`,
  `<object id="2">` (the support, the build's object 2) carries
  `<metadata key="detect_thin_wall" value="1"/>`. The importer reads object
  metadata from any vendor's 3MF into that object's config (no `BambuStudio-`
  test on that path).
- But `Plater::load_files` resets every object's config, keeping only its
  extruder, whenever a 3MF is loaded without its config: **File > Import /
  Add** (`LoadStrategy::LoadModel`), or a drop onto a plate that already holds
  objects answered "Import geometry only" (or with that answer remembered).
  Only opening it as a project keeps the override. Imported, the supports
  slice with the process's thin walls off - nothing under 0.42. This is the
  likely cause; the owner's gcode will say (an imported support shows no
  settings icon in the object list; a thin-wall pass reads as one path a line).
  To test without waiting: open the file as a project, or after importing
  turn Detect thin wall on for the support object (object list, Add settings,
  Quality).
- The files themselves are sound: each of the 24 sheet-layer shells of the
  three (4 layers x slab and leg) is closed and manifold on its own - 0 open,
  non-manifold or mis-wound edges, no self-intersection, Euler characteristic
  0 (one hole) - its mid-layer section two closed contours, 2A / P = 0.400 /
  0.360 / 0.300 mm. The support object as a whole is closed (0 open edges);
  its 3,826 non-manifold edges are its parts meeting face to face (the card
  does not weld), the same in the 0.43 file Bambu does print.

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
  under the clamp's ceiling was detected at the card's old 60 deg and held by
  side tips; at its 35 now, as Bambu at 30, it is left alone.
- Sloped and curved ceilings get a STAIR (section 7) where their tips' levels
  fail and they lie on one fall; a dome (no one fall) still has its tips cut
  at the gap.
- The stair's tree carries up to 3.6 x Bambu's toolpath through its middle
  (section 7): the planner merges a crowd of tips later than Bambu's slim
  tree. Thinning it is a planner ticket.
- The stair's tree merges through a crowd (`mergeThroughCrowd`): a leg may
  pass through, or graze, a member it does not join. The card keeps every
  part its own shell, so nothing changes in print; where a leg only grazes,
  the weld - support:shells' reference - closes a sliver of void the shells
  do not (the tilted box, z 6.10, 0.009 mm2), and support:shells counts no
  void under one bead's cross-section (0.08 mm2) as a hole. Held to the
  planner's usual rule instead, the stair's tips merge nowhere (93 struts on
  the arc, 294 on the tilted box).
- G-scope's support row builds as before (no `interface`).

## 7. The stair: a sheet under a curved underside

`sheet()`'s THE STAIR (`nso_support_interface.js`), built through
`parts({ interface: true })` like every sheet. Gate: `npm run
support:curved` (`tools/nso_support_curved_check.js`), which also
writes the arc with its supports as the card exports them to
`tools/supports-stair-out/simple_overhang_supports.3mf` (git-ignored) - open
it in Bambu Studio as a project and slice with its own supports off.
27 checks.

**The gap it closes.** The sheet's contract is for ceilings: one z, four
layers. A curved underside has no single z: every tip on the arc of
`fixtures/supports/simple_overhang.3mf` (the Simple Overhang Test) was a
level of its own, too narrow for a sheet, and was cut at the gap - 40 bare
tips under the curve, nothing between them.

**The reference.** Bambu Studio's own tree on the same file
(`fixtures/supports/simple_overhang_bambu.gcode.3mf`, tree slim, threshold
30) builds a STAIRCASE OF RIBBONS, one a layer, z 41.8 - 46.2: an interface
strip 1 - 2 lines wide (0.5 - 1 mm along the curve) across the overhang's
whole width (10.32 mm lines), 22 - 33 mm of line a layer, 4 lines (46 - 48
mm) where the surface flattens at the top; a transition strip beside it;
each layer's strip ~0.55 mm further up the curve, so consecutive strips
overlap; a few branch tips (4 - 23 mm of support a layer), not trees; 0.2
of air to the part.

**What is built** (the arc at 35 deg, the gate's build; supports-curved-sheet
round 2 - the first round's grid strips, 1.68 - 2.52 mm across and resting
on one another with five tips at the foot, were a cantilever: the stair's
lean, 0.55 mm a 0.2 mm layer, ~70 deg off upright, was its load path, and a
strip's back edge sat up to 0.92 mm under the curve):

| what | z | here |
| --- | --- | --- |
| caps | to z_cap 37.00 | 2 of the plan's tips carry the transition: caps 3.75 and 2.00 mm, and 1 tip of the stair's own tree |
| transition | 37.00 - 37.20 | the lowest band again, one layer under it |
| bands | 37.20 - 46.20 | 45, one a layer, 9.75 mm along the arc: one line (0.40) on 23 of them, z 37.4 - 41.6, where the slope is 25 - 45 deg; two beads (0.84, a loop alone) on 22, z 41.8 - 46.2 |
| the stair's tree | 46.2 - 0 | 89 tips, 1 - 2 a strip under each strip's leading part (5 mm or nearer along it), merged onto 2 trunks to the plate |
| held | | the plan's 38 other tips on the curve: not built, nor any member that holds only them |

- **Which tips.** The tips whose levels failed (one tip a level, or no piece
  of 2 mm lines), 1.6 tip spacings or nearer one another, at least three,
  their contacts on an underside whose fitted plane falls 3 - 70 deg and
  spans two layers or more. A flat ceiling's tips are on levels that built,
  so a ceiling never becomes a stair: its sheet is the four layers, byte for
  byte (the coupon's build hashes the same as before, `support:curved` 7).
- **Each layer's band** is laid where the gap puts it, not on a grid, so it
  moves with the curve a layer at a time (0.2 - 1.1 mm on the arc): along
  the arc's lines every 0.25 mm, its front edge is the first point up the
  slope where the layer's column (the gap under it to the gap over it) is
  clear of the piece and the underside is within 3 mm over it; the run of
  those longest along the arc is the band, one region. The stair starts at
  the lowest layer whose band runs 0.6 of the longest and holds a tip, and
  where even one line would stand too far under the part (the arc's foot,
  ~45 deg: 0.6 - 0.8 mm), it starts higher.
- **Width follows the band** (superseded by supports-stair-body, below) (Bambu's: a loop alone - two lines - on most
  layers, four only where the surface flattens): as many beads as keep the
  band's back edge within 0.55 mm of the part over it, built and measured -
  one line (0.40, the sheet's thin wall) where two would not, two beads
  (0.84: a slicer lays a two-bead band as its loop alone) where they do, and
  three or more only where the band itself moves three beads a layer
  (never, on the arc: its flattest layers move 1.1 mm). Every band's top
  is **0.183 - 0.522 mm under the part across its whole width, median
  0.337** (`support:curved` 2: 5,360 points, front edge, middle and back
  edge, every 0.25 mm along) - the first round's grid strips were 0.23 -
  0.92, median 0.48.
- **What holds each strip.** A band lies over the band below only in part
  (0 - 0.34 mm along the slope, median 0.07): its leading part, up the
  slope, is held by TIPS, never by the stair's lean. Wherever that part is
  half a line or wider - every strip, on the arc - a tip every 5 mm or
  nearer along the strip (Bambu's tree_support_branch_distance; its own
  tree puts ~1.4 branch tops under each of its strips, 29 over z 41.4 -
  45.4), each set a quarter stretch along from the strip below's, its
  column's down-slope face at the band's front edge (where the part comes
  lowest) and its top the band's underside. The tips are the stair's own
  tree: `nso_support_gridpack.js` plans them as beacons on each band's
  underside (`plan(..., { mergeThroughCrowd: true })`: a member in a node's
  way that cannot join no longer holds the merge up - a tip a layer apart
  under every strip is crowded everywhere, and without it 184 tips merged
  nowhere and stood 93 struts on the plate) and builds them after the plan's
  trunks (`tp.stairTrunks`), joined to the stair's support. Each of the 89
  tips is found built: a column top at the band's underside (`support:curved`
  4).
- **The gap is measured**: every band with the exact triangle distance
  against the piece; one nearer than the gap moves up the slope and is built
  again. The whole support: 0.181 mm.
- **Against Bambu** (`support:curved` 5): every one of Bambu's 23 interface
  layers (41.8 - 46.2) has a band of ours at that z over the same stretch of
  the curve; ours start at 37.4 (the card's 35 deg flags more of the arc than
  Bambu's 30 deg threshold). The support's printed toolpath a layer, NSO's
  slice against Bambu's (all support features), mm: z 5: 42 / 52, z 15: 57 /
  24, z 25: 112 / 31, z 35: 232 / 107, z 38: 265 / 154, z 40: 218 / 139, z 42:
  160 / 161, z 44: 90 / 135, z 46: 26 / 46 - up to 3.6 x Bambu's through the
  middle of the tree, where our planner merges later than Bambu's slim tree.
- **NSO's slice** types every layer's band Support interface or Support
  transition (45 and 17 layers of 46 hold each; the tree's columns beside
  them are Support), its lines support lines only (`support:curved` 6). Two
  changes in `typeSupports` (`nso_slicer.js`, docs/SLICER.md): outside its
  next layer's filled outline a top is what that layer does not cover grown
  by a quarter line (0.5 mm everywhere hid each band's exposed edge under
  the next band), and it may lie a layer deeper under the host - both only
  where the part runs 2 mm or more under a sloped underside (the first layer
  over it covers under 90 % of it: under the coupon's flat leg ceiling, the
  tops of two tips beside its sheet read as a top otherwise and made its
  T T I I read T I I I, slicer:bambu section 5); and past its 2 + 2 layers a
  sheet's transition runs on while a layer repeats the footprint of the one
  over it. `slicer:supports` is still 26 of 26, `slicer:bambu` 58 of 58.
- **Build time**: the arc's area ~6 s in node.

**Round 3: each strip covers the part's step** (supports-stair-body). The
round-3 print released clean and the foot held, but the top of the stair
came loose: in Bambu's slice of our export each strip's leading line was an
overhang wall in air (a strip advanced ~0.55 mm past the one below, more
than a line), and the part's bars were dashed (our strips were narrower than
the part's step over them). Now each strip is as wide as the part's step
over it - the next layer's overhang advance - and one line (0.42), at least
two lines, so the next strip's down-slope line lies on its up-slope line;
its lines are the sheet's (0.40 at 0.84): two, a loop alone, or a loop and
one serpentine inside it, tied at one point; kept to the outline and one
line, the top strip covering all the part has left over it (spread to the
outline: 3 lines at 0.88). The stair's own tree holds each strip's leading
part as before (a tip every 5 mm or nearer).
- On the arc: 45 strips, z 37.2 - 46.0: 2 lines on 38, 3 on 7; every one
  0.27 mm or more wider than the part's step and a line, built, and 0.29 in
  NSO's slice; the part over each 0.187 - 0.457 mm across its width where
  the next strip is not over it, median 0.301; 89 tips; gap 0.181.
- `typeSupports` reads every support line's overhang as a slicer types a
  wall, span by span (docs/SLICER.md). A strip spans between the tips that
  hold it, as round 3 printed: no span of a strip's line over air longer
  than the tip pitch (5 mm, `support:curved` 6) - on the arc 55 spans over
  98 strip paths, the longest 3.38 mm.
- The support's toolpath over the stair's start (z 37.2): 7.14 m against
  Bambu's 6.22, 1.15 x (gate 1.5 x). The whole part, a finding the
  trunk-thinning follow-up (section 6) owns: 40.78 m against 13.54, 3.01 x.
- The stair's tree, planned on these strips, landed a trunk at (90, 92.5) by
  the arc's base, which held it to 11.36 mm at the plate (Bambu's 12.35):
  trunks now land off the part as Bambu's do (docs/SUPPORT-GRIDPACK.md,
  *The landing*) - on the arc two re-land, 2.0 and 4.5 mm, and every trunk
  flares to full width.

**The refusal on the arc** (`support:curved` 8). At the card's 60 deg the
arc was "Area 1 · unreachable · no route to the plate · 70 spots" (63 in the
owner's frame) though the plate under the top is clear: the planner held 67
of its spots, the top among them. Three it could not reach sit at the arc's
foot, z 17.7 - 18.7: one on its 60 deg facet over the part's own 2 mm base
(the base runs 12.8 mm on under it and 10 mm to either side; a 30 deg lean
from there reaches 9.6), two on the engraved label's flanks over the arc's
own upper face. They are honest refusals; the card's verdict was the bug:
an area with one lost spot read unreachable whole, with its whole count. Now
(`app-supports-card.js` `effective()`) an area the last build held in part
gives its lost spots an area of their own, numbered after the rest: the
arc reads held, and the row is "Area 3 · unreachable · no route to the plate
· 3 spots", outlined and framed where they are. No new control, and a
left-out area is still the one under the click.

