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
   z (clamp area 1)  what                                   slicer layer (0.2 mm) it lands in
   72.000            the part's underside
   71.820 - 72.000   air, 0.180 mm (true minimum distance)   71.8-72.0: empty
   71.620 - 71.820   I2  interface, one direction, 0.84 mm   71.6-71.8
   71.422 - 71.622   I1  interface, across I2, 0.84 mm       71.4-71.6
                         lying directly on the caps
   69.432 - 71.432   every tip's flat CAP, 2 mm of rise, its top 0.01 mm into I1
```

**supports-print-1 (the 2026-10-20 print).** The top_clip_x2 coupon printed
with our supports: the part came out clean and the sheet released, but the
trees wobbled when the sheet started, the two transition layers sagged between
tips 3 mm apart, and half the interface welded to the part and had to be torn.
Bambu's own tree on the same coupon (baselineV2, default style) has no
transition layer: its branches widen into flat caps of 2-7 mm (35 under a 40 x
20 ceiling) and the interface lies on them. So now:

- **No transition layer.** The sheet is two interface layers, I1 and I2
  (`SHEET_ROLES`), each one 0.2 mm layer (`layerMm`), I2 0.002 mm into I1.
- **Caps** (`THE CAPS` in the file's header). Every tip under a sheet ends in
  a round flat cap that follows its own leg: a frustum from where the leg's
  axis crosses 2 mm (`CAP_RISE_MM`) under I1 - 0.9 of the column's side
  across there, inside its square however it is turned - up to where it
  crosses I1's underside, its top 0.01 mm (`CAP_INTO_MM`) into I1, its last
  0.02 mm upright (`CAP_BAND_MM`: I1's underside cuts that band, not the 2 mm
  flank - cut 10 um from its top, the flank came back from the union as
  needles NSO's slicer could not close). The column is cut along its own axis
  just under the cap's top, its end inside the cap's height (the rise is
  never shorter than that needs: a 3 mm strut's cap rises 2.32 mm); the end's
  corners may stand out of the cap's flank, where the column stood before.
  A cap is as wide as its nearest neighbour allows less 0.5 mm
  (`CAP_SPACE_MM`), held to 2.5-4 mm (`CAP_MIN_MM` - `CAP_MAX_MM`). Where it
  would come nearer the piece than the gap, or near another tree's column, it
  is first slid off (by at most its top's radius less the column's half
  diagonal), then narrowed by 0.25 mm steps, down to the column's side -
  where the tip has no cap and is cut flat at I1's underside, said per tip.
  Those clearances are sampled; then every cap is **measured** against the
  piece with the exact triangle distance and narrowed until it keeps the gap.
  **Caps never overlap**: two caps nearer than their widths allow are held
  0.05 mm (`CAP_PART_MM`) apart, the narrower keeping its width - and so are
  a cap and a neighbour's bare column top, and caps of neighbouring levels (a
  tilted ceiling makes each row of tips a level of its own). Tips closer than
  2.55 mm get caps under 2.5 mm (section 4): overlapping caps, or caps whose
  tops lie in one plane, are what the kernel's union could not take (the
  clamp's area 2, tips 1.3-2.1 mm apart: 70 piercing pairs in its welded
  sheet with 2.5 mm caps overlapping; 55 with their tops' heights staggered).
- **One line, one box, at least 2 mm** (`MIN_RUN_MM`): every interface line
  is a single straight run (`NSO_RasterLines.extrudeFlat`'s section) - no
  turn, no joint, nothing cut into it. An I1 line is kept only where it lies
  across a cap (its whole width on the cap where it crosses); I2 only where it
  crosses a kept I1 line.
- **The line width is 0.43** (one bead and `SHEET_OVER_MM` 0.01, at a 0.4
  nozzle), section 5.
- **The feet**: one shared first-layer pad per cluster of trunks, the trees on
  one pad one support (docs/SUPPORT-GRIDPACK.md, *Feet*).
- **The gap stays 0.18** (V2 uses 0.2; the weld came from the sag and the
  bead, not the figure).

**The level.** A tip's sheet top is 0.18 mm under the lowest ceiling over its
cell (a point more than a layer below the tip is a lip or a wall, left to the
footprint). Tips that agree within 0.01 mm are one level: one sheet, however
many trunks they belong to. Weld joins it to every trunk carrying one of its
tips, and `shells()` groups it with them, so the region's tree and its sheet
export as one object.

**The footprint.** A sample along a line belongs to the nearest sheet tip
within 0.6 tip spacings. It is kept where the stack's column, from 0.18 below
its base to 0.18 above its top, meets nothing of the piece within 0.18 + half
a line: vertical rays for ceilings and ledges, horizontal row rays for the
inside of a wall, which a vertical ray runs parallel to and never sees. No
other support's column passes through it (as planned, and as it will be cut).
The gap is then measured on the stack with the exact triangle distance and the
level lowered (a sloped ceiling) or cleared round the point (a wall) until it
is 0.18.

**The angle is chosen.** The planner's tips stand on the beacon grid's square
lattice, so a line parallel to it and between two columns crosses no tip. Of
the candidates (0, 90, and the 1:2 and 1:1 diagonals) the sheet takes the one
that drops least of I1 (no cap under it), then leaves fewest caps with no line
on them, then the axes. With caps 2.5 mm across under tips 3 mm apart that is
usually a 1:2 diagonal (26.57 deg): the clamp's area 1, the coupon's area 1.

**The tips the sheet does not carry.**

| tip | what it gets |
| --- | --- |
| under a sheet | its cap, I1 lying on it |
| under a sheet, no room for a cap (the piece or another tree's column too near) | cut flat at I1's underside, 0.002 mm into it, as before |
| under a sheet but no I1 line lies on its cap (beside a wall) | cut under the sheet all the same; carries nothing |
| no line of any sheet reaches it, or its level has no sheet (one tip, a one-row band, no room above the foot) | cut at the gap line: its own flat top 0.18 mm under the part (finish()'s last rung), lowered until its own solid keeps the gap |
| a side tip (a face more than 30 deg off level) | drawn back along its stub until its own solid keeps the gap (unchanged) |

`finish()` and its 1.2 mm per-tip patches are unchanged and keep
`tree:interface`.

## 4. Measured (`support:interface`, 112 checks)

The clamp at the card's defaults has four areas. Every flat ceiling carries a
sheet:

| area | ceiling | tips: under a sheet / cut at the gap / side | caps (at 2.5-4 mm) | widths | lines per layer (I1 / I2), angle |
| --- | --- | --- | --- | --- | --- |
| 1 | z 72 flat (+ 45 deg chamfer 62-71, fillet 72-75) | 176 / 14 / 69 | 167 (127) | 1.95-2.50 | 92 / 96, 26.57 deg |
| 2 | z 80 flat | 45 / 0 / 0 | 45 (1) | 1.24-2.50 | 53 / 64, 0 deg |
| 3 | z 0.8-2.0 (the bottom fillet, over the plate) | 0 / 0 / 27 | none: every tip is a side tip | - | - |
| 4 | z 86 ridge | 3 / 0 / 0 | 3 (3) | 2.50 | 6 / 10, 63.43 deg |

The coupon (`top_clip_x2`): area 1, the slab at z 13.5, 40 tips, 40 caps of
2.41-2.50 mm, 26 / 30 lines at 26.57 deg; area 2, the leg at z 6.5, 9 tips
1.8 mm apart, 9 caps of 1.77 mm, 8 / 10 lines at 135 deg. One support (one
pad under both areas' trees) built in about 1.5 s.

**Caps under 2.5 mm**: where tips stand under 2.55 mm apart (2.5 mm and the
0.05 mm the caps are held apart: the clamp's area 2,
the coupon's leg, area 1's tips where trees meet) the caps are held 0.05 mm
apart, so they come out narrower - every one of them says why ("held short of
a neighbour", "narrowed off the piece"); nearest-neighbour gaps edge to edge
0.05-0.66 mm, never over 2 mm. Area 1's 8 tips with no cap had no room for
one (the piece, another tree or a neighbour too near): cut flat under I1 as
before.

- **Gap**, exact triangle-to-triangle distance over the whole interface zone
  (the sheet, the caps, every tip, 3 mm under the lowest contact):
  **0.180000 mm** on every sheet area, 0.183583 mm on area 3 (side tips
  only); the coupon too.
- **Stack**: 2 interface layers and no transition layer on every sheet, the
  top 0.18 mm under the ceiling; every cap's flat top 0.01 mm into I1, I1's
  underside on it.
- **Lines**: every line one box (8 corners) and none under 2 mm (the
  shortest: 2.05 mm, area 2); one direction per layer, each across the one
  below; pitch median 0.840 mm, no adjacent pair off a multiple of 0.84 by
  more than 0.05.
- **No tip above the sheet's underside** under any line, but a cap's 0.01 mm.
- **Feet**: one pad per cluster, none split; area 1 stands on 6 pads (76-205
  mm²) and is one support; pads 0.28 mm or more from the part. Below the zone
  the trunks are the planner's: area 1's nearest is 0.1776 mm from the part,
  with and without the sheet (pre-existing: rails are kept 0.2 mm off on rays).
- **Solids** closed, manifold, no degenerate triangle, **no piercing pair in
  any sheet**. The trees and pads below carry their own (area 1: 466 piercing
  pairs, 1036 without the sheet).

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

So the line is **0.43 mm** (`SHEET_OVER_MM` 0.01 over the bead) and **one
straight box** (8 corners) per line, at least 2 mm (`MIN_RUN_MM`). That is
outside the kickoff's 0.40-0.42 - narrower is less than a zero-width wall - and
is the owner's call (docs/HANDOFF.md). One pass per line in Bambu takes its
thin-wall detection: `tools/supports-print-out/top_clip_x2_supports_thinwall.3mf`
sets `detect_thin_wall = 1` on the support objects only, to slice beside the
plain export; the card does not set it.

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
