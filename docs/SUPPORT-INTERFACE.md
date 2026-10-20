# Support interface: the sheet a tree carries under the part

`nso_support_interface.js` `sheet()`, built by `nso_support_gridpack.js`
`parts(plan, { interface: true })` - which is how the Supports card builds
(`app-supports-card.js`, `PARTS_OPTS`). Gate: `npm run support:interface`
(`tools/nso_support_sheet_check.js`); `npm run support:interface-export`
also writes the clamp with its supports to
`tools/support-interface-out/clamp_body_sheet.3mf` (git-ignored).

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
   71.620 - 71.820   I2  interface, lines along x, 0.84 mm   71.6-71.8
   71.422 - 71.622   I1  interface, lines along y, 0.84 mm   71.4-71.6
   71.224 - 71.424   T2  transition, lines along x, 0.84 mm  71.2-71.4
   71.026 - 71.226   T1  transition, lines along y, 0.84 mm  71.0-71.2
                         serpentines resting on the tips
   71.028            every tip under it cut flat here, straight up from its own leg
```

Each layer is one 0.2 mm layer (the print's: `layerMm`, default 0.2), set
0.002 mm into the one below (`finish()`'s joining overlap); T1 sits 0.002 mm
into the cut tips. Lines are 0.42 mm (`NSO_Thickness.floorFor(0.4)`), the
section `NSO_RasterLines.extrudeFlat` gives every crosshatch line, and each
layer passes `NSO_Crosshatch.oneDirection`, the crosshatch's own guard.

**The level.** A tip's sheet top is 0.18 mm under the lowest ceiling over its
cell (a point more than a layer below the tip is a lip or a wall, left to the
footprint). Tips that agree within 0.01 mm are one level: one sheet, however
many trunks they belong to. Weld joins it to every trunk carrying one of its
tips, so the region's tree and its sheet export as one object.

**The footprint.** A sample along a line belongs to the nearest sheet tip
within 0.6 tip spacings. It is kept where the stack's column, from 0.18 below
its base to 0.18 above its top, meets nothing of the piece within 0.18 + half
a line (x root 2 at a turn's mitred corner): vertical rays for ceilings and
ledges, horizontal row rays for the inside of a wall, which a vertical ray runs
parallel to and never sees. No other support's column passes through it (as
planned, and as it will be cut). The gap is then measured on the stack with
the exact triangle distance and the level lowered (a sloped ceiling) or cleared
round the point (a wall) until it is 0.18.

**Nothing floats.** T1's runs are joined end to end into serpentines (a turn
straight across at the inner end of the two runs, never a diagonal along a
line) and a serpentine is kept only if it crosses a cut tip; T2 runs only if
they cross a kept T1 run; and so up. A sheet needs two tips its T1 crosses.

**T1's angle is chosen.** The planner's tips stand on the beacon grid's square
lattice, so a T1 line parallel to it and between two columns crosses no tip;
the reference's tips are irregular and its axis lines meet them. Of the
candidates (0, 90, and the 1:2 and 1:1 diagonals) the sheet takes the one that
drops least of T1, then leaves least of it hung from turns alone (10 % bands),
then the axes. On the clamp it is the reference's own: along y.

**The tips the sheet does not carry.**

| tip | what it gets |
| --- | --- |
| under a sheet | cut flat 0.972 mm under the ceiling; T1 rests on it |
| under a sheet but no T1 line crosses it (beside a wall) | cut under the sheet all the same; carries nothing |
| no line of any sheet reaches it, or its level has no sheet (one tip, a one-row band, no room above the foot) | cut at the gap line: its own flat top 0.18 mm under the part (finish()'s last rung), lowered until its own solid keeps the gap |
| a side tip (a face more than 30 deg off level: its stub runs sideways into the face) | drawn back along the stub until its own solid keeps the gap, while the stub stays longer than its own mitre (a shorter leg folds the sweep over itself); past that the stub goes and the drop rises straight up from the elbow toward the face until it keeps the gap (the clamp's 45 deg chamfer) |
| feet on the plate, pads resting on the part | unchanged |

`finish()` and its 1.2 mm per-tip patches are unchanged and keep
`tree:interface`. Its pitch is 1.2 because its patches are boustrophedons and
`nso_crosshatch.js` refuses end turns at 0.84 mm with a 0.42 mm line (clearance
0, measured: a turn there welds along the layer above). That reason is about
turns welding to a separate layer; the sheet's four layers are one support, so
its T1 turns may weld to T2, and its other layers are open lines.

## 4. Measured (`support:interface`, 52 checks)

The clamp at the card's defaults has four areas. Every flat ceiling carries a
sheet:

| area | ceiling | tips: under a sheet / cut at the gap / side | sheet | lines per layer (T1/T2/I1/I2), pitch |
| --- | --- | --- | --- | --- |
| 1 | z 72 flat (+ 45 deg chamfer 62-71, fillet 72-75) | 176 / 14 / 69 | top 71.820, T1 along y | 52 / 51 / 53 / 51, 0.840 |
| 2 | z 80 flat | 45 / 0 / 0 | top 79.810, T1 along y | 25 / 27 / 25 / 28, 0.840 |
| 3 | z 0.8-2.0 (the bottom fillet, over the plate) | 0 / 0 / 27 | none: every tip is a side tip | - |
| 4 | z 86 ridge | 3 / 0 / 0 | top 85.820 | 4 / 11 / 4 / 11, 0.840 |

Area 1's 14 gap tips are the fillet's one row at z 72.8: a level of its own
whose band is one row wide, so T2 crosses no T1 line there and the sheet is
refused ("a sheet needs two tips its lines cross"). Its 69 side tips hold the
chamfer. A few tips on areas 1 and 2 stand beside a wall where no T1 line
crosses them; lines of the sheet pass over them, so they are cut under it.

- **Gap**, exact triangle-to-triangle distance over the whole interface zone
  (the sheet, every tip, 3 mm under the lowest contact): **0.180000 mm** on
  every sheet area, 0.183583 mm on area 3 (side tips only). The sampler
  (`minDistance`, `finish()`'s) agrees wherever the zone is small enough for
  it (areas 3 and 4, the fixtures); on areas 1 and 2 a flat top lying exactly
  the gap under a ceiling costs it millions of refinements (150 s for area 1,
  measured) and the exact distance stands alone.
- **Directions**, read off a slice of the welded solid at each layer's middle:
  90 / 0 / 90 / 0 deg on every clamp sheet; one direction carries 0.97-0.985 of
  each layer's edge length on area 1 (the rest: T1's turns, line ends).
- **Pitch**, the same slices: median 0.840 mm on every layer of every sheet,
  no adjacent pair off a multiple of 0.84 by more than 0.05 (area 1: 52 / 51 /
  53 / 51 lines).
- **No tip above the sheet's underside** under any line, on every sheet.
- **Below the zone** the trunks and pads are the planner's, no nearer the part
  than without the sheet: area 1's nearest trunk is 0.1776 mm from the part
  with and without it, its pads 0.1445 mm - both under 0.18 and both
  pre-existing (rails and pads are kept 0.2 mm off on rays, not as a true
  distance). A cut tip keeps its column's square turned as it was (the sweep's
  frame is seeded so), or that trunk came 0.009 mm nearer.
- **Solids** closed, manifold, no degenerate triangle, **no piercing pair in
  any sheet** (NSO_Repair.js's count, which `selfint:equiv` holds to
  `mesh_validate.py`). The trees and pads below carry their own: area 1 has
  16152 piercing pairs without the sheet and 6809 with (the bare tips' tops
  at the ceiling were most of the difference); area 2 4413 and 4421, 2923 of
  them in the pads.
- **One object per area**: each sheet is joined to every trunk that carries
  one of its tips, so the clamp's build is 4 support pieces (11 without).

**Build time, the card in Chromium** (`GENERATE`; detecting / planning /
building in the worker, welding on the page - and, for an area with a sheet,
in the worker at the same time):

| piece | | total | planning | building | welding | longest page stall |
| --- | --- | --- | --- | --- | --- | --- |
| clamp, standing (4 areas) | before | 20.0 s | 4.0 s | 0.3 s | 15.0 s | 489 ms |
| | after | 26.1 s | 4.2 s | 3.3 s | 17.9 s | 439 ms |
| the wedge, `v9_mirror_factory` (25 areas) | before | 16.3 s | 3.7 s | 2.2 s | 8.9 s | 707 ms |
| | after | 23.6 s | 4.4 s | 4.7 s | 13.2 s | 695 ms |

The sheet is planned and its tips are built in the worker (`building`). An
area that carries a sheet is welded in the worker too (the card's worker
loads `nso_csg.js` for it): the sheet's lattice is one union of about 200k
triangles (25 per line crossing), then one union with every trunk it stands
on, and `_finishUnion` over the result - on the page these held it for 1.2 s
and went to the boolean worker, whose own bar and "Joining... N s" took the
card's status line. In the worker they run while the page welds the areas
without a sheet. The probe of the piece is prepared once per build, not once
per area (0.6 s of the wedge's 49k triangles, 25 times over).

`support:workflow` (147 checks, the card driven in Chromium) holds the wedge's
build inside its 50 s budget: 24.2 s here. `tools/nso_support_sheet_check.js`
in node: planning 41 s (node's vm context, not the page), parts 0.6 -> 8.9 s,
weld 17.0 -> 22.7 s on the clamp.

## 5. Not done here

- MAX_SPAN_MM stays 3.29 (tips at 3 mm on the beacon grid). Opening the
  pitch to the reference's 3.8-5.7 is a follow-up once the sheet has printed.
- No detection change (`nso_support_aim.js` untouched): the 45 deg chamfer
  under the clamp's ceiling is detected at the card's 60 deg and held by side
  tips; Bambu at 30 deg leaves it.
- Sloped and curved ceilings get no stair-stepped sheet: a tip on one is a
  level of its own, usually too narrow for a sheet, and is cut at the gap.
- G-scope's support row builds as before (no `interface`).
