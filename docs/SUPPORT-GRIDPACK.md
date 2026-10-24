# Grid-pack supports — grown from the support points down to the plate

`nso_support_gridpack.js` (`window.NSO_SupportGridpack`, and a Node module).
Test: `npm run support:gridpack` (`tools/nso_support_gridpack_test.js`, in `npm test`).

It **replaces the trunk-first planner** (`planSolid` in `nso_support_tree.js`,
`docs/SUPPORT-TREE.md` §4–5). `NSO_SupportTree.planTree` keeps its name and its
callers and now returns this planner's plan. G-scope's three styles all use it:

| style | what changes |
|---|---|
| Straight strut | merge eagerness 0: one straight post per support point, never merged |
| Tree | merge eagerness 1: pairwise merges on the node lattice |
| Gecko-hand | the tree's plan exactly, plus a hand at every point |

What stays: the sweep (`nso_path_sweep.js`), the interface finish
(`nso_support_interface.js`, fed by `plan.stations`), hollowing (`hollowTree`,
now bores on this planner's members), the union (`unionParts` / `_finishUnion`)
and the 3MF object path. `NSO_SupportAim.nearestBase` / `aim` / `plan` also stay:
`nso_assemble.js` and their own suites use them. Only the support planner
stopped using them.

---

## 1. Why

The trunk-first planner planted one trunk under the contacts' centroid and
fanned branches up from one collar. One contact outside the fan's reach refused
the whole region:

- a flat face tilted 30° refused with *"widest branch leans 180° off vertical"*
  (contacts below the split);
- the straight strut built one post at the region's centre;
- a second Generate stacked a support inside the first.

Direction: **over-support by default, refuse only the impossible.**

## 2. The planner

Deterministic. Dials:

| dial | value | source |
|---|---|---|
| strut side `s` | `buildStrut`'s, 1.2 mm, never under `NSO_Thickness.floorFor` | existing strut law |
| point pitch `p` | the detector's own 3 mm, widened for fat struts (below) | the beacon grid |
| lean limit θ | `BRANCH_TILT_DEG` **30°** | the proven structure's widest lean was 31.44° (p95 26.83°); rounded down so every leg sits inside it, and so a face tilted exactly 30° is a face a vertical post holds |
| foot pad | one first layer (0.2 mm) per cluster of feet (within 6 mm): the union of the footprints grown 4 mm, 0.2 mm off the piece | §2, *Feet* (supports-print-1) |
| node lattice `L` | 5 mm: nodes every L/2 = 2.5 mm in x, y and z (z from the plate) | the ticket; Bambu's own 2.5/5 lattice |

**Beacons.** `{ p, n }`: a point on the surface and its outward normal.
`gridBeacons` is the adapter: **`NSO_SupportBeacons.detect`'s own beacons**
(`docs/SUPPORT-BEACONS.md`) at the detector's 3 mm pitch (wider for a fat
strut, below), **exposed ones only**: a spot counts only if its air reaches the
outside of the piece (geometry only, `docs/SUPPORT-BEACONS.md`). The inside of a
sealed cavity is not a beacon here, so it builds nothing; a shelf over its own
base is, and reaching it is **this planner's** job (below). Each carries the id of its **beacon
region** (its area, `det.regions[i].id`, what the Supports card numbers by),
and `opts.regionId` picks one of those. The planner no longer reads
`detectOverhangs`' triangle regions or `contactPoints`' lattice.
`opts.beacons` takes an explicit list (`{ p, n }` or a detector record
`{ x, y, z, normal }`, each with an optional `regionId` and `key`): the
Supports card's, `docs/SUPPORTS-CARD.md`, and G-scope's row, which hands in the
beacons on its own triangle region labelled with its own number. Every trunk
then carries `regionIds`, and every solid `beacons`, `regionIds` and `landing`.
`plan.region` is the first beacon region of a detected plan (none for an
explicit list: the caller names its own).

**Held is every beacon with a route.** A beacon is held when it is in a landed
trunk; merging only joins members and never drops one, so on a clean face
`held` equals the area's beacon count (`plan.detect.regions[0].count`) exactly.
A beacon is *not* held only when it is inside the piece, or has no route to the
plate (and `restOnModel` is off). If a face needs more capacity, the answer is
more trunks, never fatter ones: a merged section stays capped at 4 × s².

**Level 0.** Every point starts a strut straight down. A *side* point (its face
leans more than θ off straight down, with a 0.01° tolerance so float32 noise on a
face tilted exactly θ does not decide) gets a horizontal stub of `s + 0.2 mm` out
along its normal first, then turns down.

**Descent.** Lattice levels are visited top down. A member hangs straight from
its *anchor* (its point, a merge node, a pickup point, the end of a steer). At
level `z` its lean budget is `(anchor.z − z)·tan θ·eagerness`.

**Merging.** Two free members whose budgets both reach the lattice node nearest
their midpoint lean to it in one straight leg each and become one member there.
Pairs go closest first, each member at most once per level. A merged member
carries its count: a square section of area `count × s²`, **capped at 4 × s²
(FLAG)**. **Square section (FLAG).** A node keeps its distance: the new column
and the legs into it must not touch another member, or two solids that touch
up top and meet again lower close a loop. A member in the way that can reach
the node joins (a merge of 3, never more); otherwise the merge waits a level.

**Column pickup.** A free member passing within one point pitch of a lower
point picks it up with a stub: a leg leaning θ, then a vertical last 2·s to the
point, so the tip meets the face the way a strut's does.

**Obstacles.** Every leg is tested before it is taken, with
`NSO_SupportAim`'s own rays: the axis plus 8 rails on the section's
circumscribed circle plus `CLEAR_MM` 0.2 (vertical ones through its down grid),
and `lineInsideAt` on each, because a rail starting inside a wall crosses no
face and reads clear. A blocked merge does not happen that level. A member
whose drop to the plate is blocked **steers**: for 16 headings at θ and θ/2 the
leaning line from its anchor is walked down the levels, one leg check and one
drop check per heading per level, no path search; the shallowest clear drop
wins. A drop clear through a hole in the piece is a clear drop, so openings are
found this way.

**The tip's zone.** The rail test leaves a tip's last cross-section out (on a
sloped face the cap's downhill corner meets the face by design). A side wall
there is different: the interface finish could not keep its gap (measured
0.07 mm and 0 mm on the tab and tall arms beside the post). So the tip's top
1.5 mm is swept with horizontal rays, ignoring the face being supported. A tip
in a wall is moved off it along the face's tangent plane, by ¼–1 × s, and the
move is reported in `plan.nudged`. A tip that cannot clear by the margin but
does not touch the wall stays (`plan.tight`).

**Landing.** Plate first, always.

- `restOnModel` off (default): a point with no plate route builds nothing and is
  counted *unreachable from the plate*.
- `restOnModel` on: it drops onto the piece and stands on a two-layer
  (0.4 mm) pad one support gap (0.18 mm) above the surface. It is counted
  *resting on the part*.

**Feet** (supports-print-1, `FEET` in the file's header). Every trunk that
lands on the plate stands on a pad one first layer thick (0.2 mm,
`opts.firstLayerMm`). Trunks whose feet stand within 6 mm (`FOOT_CLUSTER_MM`,
single linkage) share ONE pad: the union of their footprints grown 4 mm
(`FOOT_GROW_MM`), kept 0.2 mm (`FOOT_GAP_MM`) off the piece. Pads that would
touch (overlap, or part by less than 0.1 mm, `FOOT_TOUCH_MM`) are one pad, and
every trunk on one pad is one support: on the 2026-10-20 print the first layers
of two supports overlapped and Bambu Studio reported a path conflict between
support 1.1 and 2.2. Bambu's own tree (baselineV2, the same coupon): pads of
15-24 mm, about 900 mm of first-layer line for 10 trunks.

- **The footprint** is the circle round the trunk's end square (r = side / root
  2), whatever way the sweep turned the square, so a pad depends only on where
  the trunk lands - the same with the sheet as without it. On the card's
  build a trunk stands on its round trunk (*The trunk*, below), and the
  footprint is the circle round the trunk's flared base: the pad grows with
  the trunk.
- **Drawn on a raster** of 0.05 mm (`FOOT_CELL_MM`, coarser past 4 million
  cells): a cell is pad when its centre is within the grown circle and further
  than 0.2 mm, plus the raster's own slack (a row between two that read the
  piece, a cell's half-diagonal, the outline's simplification), from the piece
  anywhere through the slab and the gap above it (horizontal row rays, parity,
  every 0.04 mm up). The cells in the circle INSIDE the trunk's square are
  always pad, so a pad comes no nearer the piece than the trunk standing on it.
  Air the pad closes round is filled (no handle), a crack under 0.1 mm is
  closed, and a hole the piece stands in (a leg of it with trunks all round)
  is opened to the outside by a slot three cells wide - one hole at a time,
  along the way that cuts least pad, bending between the feet, ending at the
  first air it meets (`support:exposed` 4c) - so every pad is one simple
  outline, simplified to a cell, ear-clipped and extruded.
- **One raster per group of feet** whose grown footprints could come within
  0.1 mm of each other: one raster over every foot coarsened the cells with
  their spread (a foot 250 mm away made them 0.13 mm, and the keep-off's
  slack rang a thin trunk round with piece that was not there).
- **Pads too near to print apart are one support.** Pads the keep-off leaves
  under 0.1 mm apart (`FOOT_TOUCH_MM`, plus the outlines' simplification)
  are linked: their trunks are one support (`groups`), whatever the gap. A
  cluster split is counted (`clustersSplit`) when a cluster's feet still
  stand in more than one support - unless every foot apart from the rest is
  one the piece itself hems in, measured exactly (`clustersHemmed`: no point
  in the band a pad touching its end square would cover, out to 0.2 mm from
  the square, stands 0.2 mm clear of the piece through the slab, so no pad
  can touch it and keep the gap - the wedge's trunk in a pocket of
  `v9_mirror_factory` has none within 0.95 mm of its middle). A pad that is nothing but a
  foot's own end is counted (`hemmed`), and a sliver of that kind that will
  not triangulate is no pad (`padsDropped`): its trunk stands on its own end,
  in its linked support.
- **The card draws them across areas.** It builds each area with
  `footPads: 'shared'` (every trunk on its foot, no pad) and hands every area's
  `shells()` to `shareFeet(builds, piece, opts)`, which draws the pads once over
  every area's feet and joins the supports that stand on one pad into one
  object (`support:shells` §5: no two supports' first layers within 0.1 mm on
  the coupon, the clamp, the wedge).
- **Nothing below z = 0.** The pad's bottom *is* the plate; the trunk's
  end cap sits half a layer inside the pad (so it is never coplanar with the
  pad's bottom, the one input the boolean cannot be trusted with). A member
  whose last leg would reach the plate leaning stops 1 mm short and drops the
  rest straight, because a leaning cap's low corner goes under the plate.
- `opts.footPads: false` leaves them off (the suites that weigh members and
  bores on their own use it, with the reason in each).
- Pads are only for trunks that land on the plate. A resting trunk keeps its
  two-layer pad on the part.

**The trunk** (supports-foot, `TRUNKS` in the file). The round-2 print of
`simple_overhang` (NSO's export, Bambu's supports off) failed at the floor: a
~37 mm tree on a 2.4 mm column and a small round pad peeled off the plate
when the nozzle caught the stair; the tree held. Bambu's tree slim on the same
part (`fixtures/supports/simple_overhang_bambu.gcode.3mf`) stands on a round
trunk 12.35 mm across at z 0.48, narrowing at a constant angle to 5.75 mm at
z 25.0, where it splits, on a first-layer ring 16.04 mm across (201.4 mm2).
So on the card's build (`parts(..., { interface: true })`; `opts.trunkGrowth`
false turns it off, true turns it on elsewhere) every trunk that lands on the
plate gets a **round trunk of its own** (32 sides) round its foot's vertical
axis, kept as one more shell beside its column - nothing the planner built
changes, byte for byte:

    r(z) = 1 mm + tan 5.5 deg x (H - z)                    (its inscribed radius)
         + tan 15 deg x (4 mm - z), under 4 mm              (the flare)

| | value | why |
| --- | --- | --- |
| `TRUNK_TIP_MM` | 2 | Bambu's tree_support_branch_diameter: the law's diameter at H |
| `TRUNK_ANGLE_DEG` | 5.5 | Bambu's setting is 5, and its slice of simple_overhang grows at 5.2 (read against a 2 mm top at our H, 46.2); 5.5 holds every layer of its trunk with 0.33 mm to spare |
| `FLARE_MM`, `FLARE_ANGLE_DEG` | 4, 15 | Bambu's trunk widens faster over its bottom 3.8 mm (12.35 at 0.48 against its law's 10.13); covering it takes 12.4 deg more over 4 mm |
| `TRUNK_SHARE` | 0.5 | the trunk rises up its stem while the stem holds half its tips |
| `TRUNK_KEEP_MM` | 0.35 | off the piece (Bambu's support_object_xy_distance) |
| `TRUNK_TIP_CLEAR_MM`, `TRUNK_TIP_REACH_MM` | 4, 5 | under any tip within 5 mm: under every cap (2 mm rise), the sheet and the gap |

- **H** is the top of what the trunk holds up: its highest tip, or the top of
  the sheet or stair a tip of it is under; a stair's own trees are as tall as
  the stair. All three trunks under the arc are H 46.2.
- **How high.** From the pad up its STEM - the landing member, then at each
  merge the parent holding most of its tips - while the stem holds at least
  half of them: where the tree splits, the trunk ends. A taproot (a strut
  never merged) is its own stem. It ends 4 mm under every tip within 5 mm of
  it, any tree's, any area's (`shareFeet` reads every area's tips), and
  keeps 0.35 mm off the piece, read with the nearest-face probe every
  0.25 mm up its axis: where the piece comes nearer it is narrower there
  (rings a millimetre apart), and it ends where it would be narrower than its
  own column.
- **The landing** (supports-stair-body). Bambu's trunk foot on
  simple_overhang stands 3.86 mm off the part's base on the first layer
  (its first-layer ring to the part's outer wall, edge to edge, 0.5 mm
  lines; `support:foot` 5b measures it): `TRUNK_FOOT_CLEAR_MM`. On the
  card's build (trunks grown) a trunk whose flared foot would stand nearer,
  or whose law would not fit `TRUNK_KEEP_MM` off the part up its stem, is
  re-landed: the landing member's drop leans from the point it falls from to
  the nearest point (0.5 mm apart, 32 directions, within the plan's branch
  lean from that height) where the whole trunk fits and the leaning leg is
  clear, and the trunk flares to full width there (`tp.relanded`). None
  found: it lands as planned and is narrowed. On the arc two re-land (2.0
  and 4.5 mm); on the coupon two (~1.7 mm), and its three trunks at x 82.5
  find no landing within the lean and stay narrowed. Without trunk growth
  (G-scope, `solid()`) nothing moves.
- **Its pad** is the flared base's circle grown 4 mm (as before, from a
  larger circle), the base's inscribed circle always pad. A trunk that comes
  within 0.1 mm of another support's solid makes the two one support, as
  pads too near to print apart do.
- **Measured** (`support:foot`, 14 checks): on the arc, three trunks, 13.03 mm
  across at the plate, to z 21.2, 26.2 and 33.0; at each of Bambu's 93 trunk
  layers (z 0.48 - 25.02) every trunk of ours standing there is wider than
  Bambu's, by 0.33 mm or more (12.69 against 12.35 at z 0.48, 6.08 against
  5.75 at z 25.02); one pad, 614.2 mm2 against Bambu's 201.4. The
  coupon: 14 trunks, 5.35 - 6.70 mm at the plate, its pad 578.3 -> 695.7 mm2,
  covering the old one. Built with trunkGrowth off both are #265's bytes; with
  it every part before is there byte for byte, then the trunks, then the pads.
- **Not changed**: G-scope's support row and every build without the sheet
  (`solid()` on its own, the suites that weigh members and pads) build as
  before. NSO's slice of the arc's export lays more support a layer low down
  (z 5: 205 mm against 42 before and Bambu's 52): Bambu's trunk is one or two
  loops round air, ours is solid.

**Refusal.** Only a support point inside the piece (`lineInsideAt` along its
own normal). Beside good points it is left out and named. If every point is
inside, the plan refuses in one line: *"Every support point is inside the
piece, so there is nowhere to start a support."*

**Geometry.** Each member is one `NSO_PathSweep` of a constant square section
along its polyline, every bend a mitred joint. Each part's square is turned by
its own phase (golden angle × index, mod 90°), so no two parts share a wall
plane. A member formed at a node starts half its side above the node. Members
ending in a junction run on past it by a quarter of the member they join, so
no two leg ends share a vertex. Each landed trunk (with its foot) is folded through
`NSO_unionSoups` into one solid; trunks that touch are joined, in balanced
rounds (a whole slope can end up one solid, and folding trunks into one growing
solid one at a time took 13 s on a 98-trunk face against 5 s now); the rest go
side by side in one soup. `opts.hollow` bores every member whose `side − 2·wall` is
at least the floor.

**Idempotent.** Every order is fixed, so the same input gives the same bytes.
G-scope's Generate on a region that already has supports replaces them as one
undo step.

**Progress.** `plan()`, `parts()` and `weld()` take `opts.onProgress(msg)` and
tell it `{ phase, done, total }` as they go, once per unit finished:

| phase | where | count |
|---|---|---|
| `detecting` | `plan()`: the plate and the spatial index | none (`null`, `null`) |
| `planning` | `plan()`: beacons settled / beacons given (a beacon inside the piece is settled when it is refused) | `done` / `total` |
| `building` | `parts()`: units done / `buildUnits(plan, opts)` - with the interface sheet, its tips first (one per tip that is not a side tip, told off by `sheet()`'s `opts.progress` as the level's footprint raster is read and each level's gap holds), then one per trunk swept | `done` / `total` |
| `welding` | `weld()`: the unions | none: how many joins there will be is not known until the last is done |

A phase with no count says so with nulls; no total is ever guessed. `done` never
goes down within a phase and never passes `total`. Between units the last message
is repeated once 200 ms (`HEARTBEAT_MS`) has passed, and `beat()` does the same
from inside the steer, nudge and merge loops, so the gap between messages is at
most 200 ms plus the longest single call that does not beat - the first detect
and index of a piece, the feet's raster, one wasm union. A callback that throws is
ignored.

`solid(plan)` is two calls now: `parts(plan, opts)` (the BUILDING half, a trunk
at a time, with `opts.yieldFn` given a turn between trunks) then
`weld(plan, parts, opts)` (the unions, with `yieldFn` after each). `solid` with
no callback and no `yieldFn` is the same bytes as before: it runs the sync
`trunkParts`, which `parts()` shares with it, then `weld`.

**A sheet's join, voids or no voids** (supports-stair-body). `weld()` joins
each sheet's folded layers to the trunks that carry its tips and refuses a
sheet that meets none of them. The kernel's test for "they met" is fewer
parts out than in, and it counts every closed surface as a part - a void
inside the solid too. A stair's strips stacked over the legs of its tree
seal hairline slits between a leg and a strip: on the tilted box 45 voids of
0.003 mm3 or less round ONE solid, read as 53 parts out of 4 + 1, "do not
touch". Where the kernel says they do not touch, the result and both inputs
are counted again as solids - connected surfaces of positive volume - and
the join stands when that count fell.

**The carriers go in one at a time.** The solids a sheet meets are put through
the kernel one by one (`stackUp`) before the sheet is added, not handed over
as one soup of solids side by side. Solids that only graze ("do not touch")
are not settled by being concatenated: with the sheet added, the kernel
resolved a pocket between a stair tree's legs (0.12 mm2 at z 8.7, from z 7.3
to the sheet at 10.3, a hair of 0.015 mm at its neck) with a 0.08 mm wall across
it, which the separate shells do not have - 10 sections of the tilted box with
one hole fewer than the shells (support:shells). One at a time the pocket
comes through whole at every layer.

**Shells, no weld.** `shells(plan, parts)` is `solid()`'s answer with no
boolean: every part (column, foot, stub, pad bridge and fill, each layer of the
interface sheet) is kept as its own closed shell, and the parts are grouped into
the solids `weld()` would have made - trunks on one pad (`parts.padGroups`)
and each sheet with every trunk carrying one of its tips (each cap with its
own column). Synchronous, milliseconds. A slicer fills an object's overlapping
shells as one, so the printed layers are the weld's: `support:shells` cuts both
with `nso_slicer.js` at every 0.2 mm layer and holds them to two microns. The
Supports card calls `parts` then `shells` in its worker; `weld` stays for
`solid()` (G-scope's row, and `hollow`, whose bores are a subtraction from
one solid).

## 3. Measured (`support:gridpack`, 80 checks; `support:exposed`, 129)

| fixture | result |
|---|---|
| **tilted box 30°** (40 × 12 × 6 on its edge) | 44 of 44 held (the detector's beacons; the lattice gave 50), 26 trunks, all on the plate, no refusal; 12 pickups, 5 merges; every leg within 30°; mesh_validate clean, one shell per solid |
| **closed hollow box, 30°** (`library/box_closed.stl`) | `support:exposed`: **1 area, 238 beacons, 238 held** on 98 trunks (62 merges, 78 pickups), none unreachable; worst leg 29.8°; no beacon on the cavity; 98 trunks in 10 clusters of feet stand on ONE pad (2359 mm², supports-print-1: the footprints grown 4 mm meet) and are one solid with no handle (Euler 2; one hole of air filled, one round the piece slotted), nothing below z = 0, 0.296 mm from the piece |
| **flat shelf, 3 × 3** | 12 beacons (9 face + 3 corner `edge` beside the post, which the lattice could not see); 3 first merges, each at the predicted level (within 0.1 mm); every merge 2 members except one of 3 |
| **box with a through-hole** | 26 of 26 held (the arm's whole underside, since supports-followups; 9 of 9 before); 25 steered; 22 trunks, each in the hole or beyond the block's edge, none through the block; every last run upright |
| **mushroom on a wide stem**, rest OFF | 12 of 12 cap points *unreachable from the plate*, nothing built, no refusal |
| same, rest ON | 12 of 12 *resting on the part*, on the stem top (z 6), pad at 6.18 |
| **boss** | **28 of 28 held** (trunk-first: 24); 4 trunks, all to the plate; tips moved off the boss and post |
| **60 mm overhang** | 28 of 28 on **one trunk**, its section capped at 2.4 mm (4 × the strut area) |
| **Generate twice** | identical bytes (2,936 triangles on the boss) |
| strut style | no merges or pickups: 9 posts for 9 points |
| **pads under a slab** (`support:exposed` 4b) | 3 × 3 struts 5, 6 and 9 mm apart: one pad, one solid; 12 mm apart: 9 pads of 74.1 mm², 9 solids, no slab half way between two feet |
| **a post with feet all round it** (`support:exposed` 4c) | a 1 mm post ringed by 8 feet, two posts, an 11 × 11 grid round two posts: one pad each, slotted (1, 2, 2), one support, 0.26 mm off the piece |
| gecko-hand | the tree's plan exactly; mesh clean, no handles on the boss |
| point inside the piece | the one refusal, one plain line; beside a good point it is left out and counted |

Status lines are plain: *"Holds 28 of 28 support points on 1 trunk to the
plate."*, *"Holds 0 of 12 support points; 12 unreachable from the plate."*.

**On the reference** (`tree:reference`): the 70 mm tabletop's 484 points land on
81 trunks; Bambu's slice used 36. One reference trunk's 10.65 mm cell lands on 3.

## 4. Robustness sweep (not a suite; recorded here)

9 shapes × 3 styles × sizes 1.2, 2 and 3 mm, every output through mesh_validate:

- **Size 1.2 (default), tree and strut:** every case PASS, one shell per solid.
- **Sizes 2–3, tree and strut:** every case PASS (closed, manifold, no piercing).
  On tilted faces some neighbouring trunks fuse into loops (Euler below 2 per
  solid). A closed mesh, but a handle.
- **Gecko-hand:** default size PASS. On sloped faces at 1.2 and at Size 2–3,
  hands can still touch across trunks (handles). One case at Size 2 (shelf)
  leaves 2 grazing piercing pairs. **Known residual.** Gecko-hand is the shape
  option, and the handles are what `docs/SUPPORT-TREE.md` §5 measured for hands
  that reach too far.

Fixes the sweep forced, each measured:

- the point pitch widens with the strut, so a merged column clears the next row;
- the per-part square phase (a pickup stub's walls in its column's wall planes
  gave 4 non-manifold edges);
- a merge capped at 3 members (a 12-leg star on a 40° face was non-manifold);
- junction run-ons (shared leg ends pinched the union into 2 piercing pairs).

## 5. What changed elsewhere, and why

| file | change |
|---|---|
| `nso_support_tree.js` | `planSolid`, `splitPoint`, `clearWalls`, `probeRails`/`probeClear`/`clearFingers` and the root/split constants removed. They were the trunk-first planner. `planTree` delegates; `hollowTree` hands a grid-pack plan to its `solid({hollow})` |
| `app-gscope-support.js` | every style through `planTree` + `NSO_SupportGridpack.solid`; Generate replaces; an empty plan adds nothing and says why. No markup changed |
| `tree:test` | §2–5 asked about the split, the fan and the carried contact, which are gone; rewritten to ask the new planner the same things (every contact held, rails catch the window, gecko changes only tips) |
| `tree:canonical` | the parts are a trunk column and a strut; Euler is 2 per solid |
| `tree:round*` | the round/tapered parity was the old planner's; bores are now checked leg by leg on mitred members; the taper primitive is still pinned |
| `tree:interface` | stations come from the plan; `wallClearanceMm` gave way to the planner's own tip test |
| `tree:reference` | trunk count on the tabletop, and one cell's share, instead of `trunksNeeded` and the split height |
| `support:inside` | "refused at the base" was the old trunk; now no leg of any member runs inside the part |
| `gcode:gscope-support` | direct calls through the new planner; + "Generate again replaces" |
| `tools/nso_support_slice_artifact.js` | `--tree` ported |
| `tools/nso_curved_branch_probe.js` | historical: it measured the trunk-first planner and no longer runs against `planTree` |

### Support-aim index (what changed, and what was re-pinned)

Nothing was re-pinned: every plan is the same JSON, byte for byte.

| file | change |
|---|---|
| `nso_support_aim.js` | one BVH per piece (docs/SUPPORT-AIM.md, "The spatial index"): `nearestHit`, `closestOnSoup`, `lineInsideAt`, `nearestHitDown`, and the inside test by crossings / a bound; `Math` read from locals in the hot loops |
| `nso_support_gridpack.js` | `plan` builds (or finds) each obstacle's index once, and checks it against the soup; the probe's straight-down rays use the index's footprint variant in place of the XY grid |
| `support:index` (new) | the index against the walk, bit for bit; the wedge's 377 points under 30 s, to the plan it always planned |

### Supports-followups (what changed, and what was re-pinned)

| file | change |
|---|---|
| `nso_support_beacons.js` | exposed only is "the air reaches the outside", not "the normal's ray does": the normal first, then a fan of 96 rays; `counts.sheltered`; a hit on the bounding box's own wall is a hit |
| `nso_support_gridpack.js` | pads are discs without rings: touches bridged, gaps filled (`solid().padGaps`, `opts.padGaps`); prism and ear-clip helpers |
| `tools/nso_support_slice_artifact.js` | the tree is built on its foot pads again (`slicer:bambu` re-run; its pins held, the strand positions it prints moved with the footprint) |
| `support:exposed` | 63 → 114 checks: pads as one slab (section 4b, 5 mm and 6 mm lattices), shelf / bridge / arch / tunnel beacons, reachability, a sealed block still 0; budget 40000 → 81000 |
| `support:gridpack` | the through-hole case: every trunk is in the hole or beyond the block's edge, not "all in the hole" (the arm's whole underside is held now); handles allowed (22 trunks in an 8 mm hole touch above a shared foot) |
| `support:workflow` | section 9 runs with the default settings: its `exposedOnly: false` switch is gone |

### Supports-exposed (what changed, and what was re-pinned)

| file | change |
|---|---|
| `nso_support_beacons.js` | exposed only; a crease must hang in air (docs/SUPPORT-BEACONS.md) |
| `nso_support_gridpack.js` | `gridBeacons` calls `NSO_SupportBeacons.detect`; beacon regions; held == beacons on a clean face; the foot pads and their union (balanced rounds); upright last run; side-beacon tolerance |
| `nso_support_tree.js` | `BRANCH_TILT_DEG` 31.44 → 30 |
| `app-gscope-support.js` | `planFor` hands the planner its triangle region's own beacons (the planner's `regionId` is a beacon region now) |
| `tree:test` | the shelf's points are the detector's: 16 face + 3 corner = 19, where the contact lattice gave 16 |
| `tree:reference` | `BRANCH_TILT_DEG` is 30: between the structure's p95 and its widest, not equal to the widest |
| `tree:canonical` | a lone strut's union equals its column to 1e-3 mm³, not 1e-9; built with `footPads: false` |
| `tree:round`, `tree:test`'s build | `footPads: false`: they weigh members and bores and a handle-free Euler; three close trunks' pads ring a gap by design |
| `tree:interface` | the tall arm's wall-clearance scenario is handed the old lattice's 28 points explicitly (the detector's grid does not put four at 0.13 mm off the post) |
| `support:beacons` | the cavity case: one beacon per cell, one region, the ceiling interior (two before) |
| `support:gridpack` | loads the detector; the shelf is 12 points (9 face + 3 corner) |
| `support:exposed` (new) | §3 of this file |
| `docs/img/support-gridpack-tilted-box.png` | dropped |

## 6. Flags and out of scope

- **FLAG** foot pad: 0.2 mm thick (the 0.2 mm layers the gaps here are sized
  for; `opts.firstLayerMm`), one per cluster of feet within 6 mm, the
  footprints grown 4 mm, 0.2 mm off the piece (supports-print-1's numbers).
- **FLAG** exposed-only keeps an overhang that has more of the same piece
  directly below it (supports-followups; docs/SUPPORT-BEACONS.md, *Exposed
  only*): a cap over a wide stem, a shelf over its base, an arch over its floor
  all get beacons, and the planner decides what the plate can reach. The
  ones it cannot reach are counted unreachable; they cost the planner about a
  third of a second each to give up on (the 59 of the workflow's tunnel: 25 s).
- **FLAG** a fan of rays is a sample, not a proof, that a spot's air reaches the
  outside (docs/SUPPORT-BEACONS.md, *Limit*).
- **FLAG** foot pads: drawn on a 0.05 mm raster, not as an exact polygon
  union; a crack under 0.1 mm is closed and every hole filled or slotted, so a
  pad has no handle, but its outline is a cell's width off the exact union.

- **FLAG** square section everywhere (but the round trunk on the card's
  build); area cap 4 × s²; merges of up to 3.
- **FLAG** the trunk (supports-foot): Bambu's law at 5.5 deg from a 2 mm top,
  a 15 deg flare over 4 mm, up the stem while it holds half its tips; solid,
  not Bambu's loops round air.
- **FLAG** pickup reach = 1.05 × the pitch; the stub's vertical last run is 2 × s.
- **FLAG** resting pad: 0.4 mm, a 0.18 mm gap above the surface (a floating
  first layer, as slicers print support-on-model).
- Hollowing bores only merged members at the default size: a single 1.2 mm
  strut would leave 0.36 mm, which no slicer keeps.
- Ray tests on leaning legs are brute force. Steering is cheap on these
  fixtures (the suite runs in about 35 s); a 30k-triangle part wants the 3D
  index `docs/CURVED-BRANCH.md` §2b names.
- Out of scope, as asked: economics dials beyond L, curved legs, UI, GRISPR.

## 7. Feed: the user's points (supports-custom-engine)

```
npm run support:feed    tools/nso_support_feed_check.js
```

The engine half of three ways to feed the planner; the card that picks one
is the next ticket. The planner's behaviour is unchanged: a feed changes
which tips it is handed, where a trunk may land, and what it must keep out
of. `plan(rawTris, opts)` (and `NSO_SupportTree.planTree`, which calls it)
takes one more option, every field optional:

```
opts.feed = {
  mode:         'auto' | 'assisted' | 'custom'      (absent: auto)
  tips:         [{ x, y, z }]      the user's tips, on the piece's underside
  beaconsOff:   [tip ids]          assisted only: detected beacons not to plan
  landingZones: [{ x, y, r }]      on the plate
  excluded:     [ids]              from a previous build: the eraser
}
```

| mode | the tips planned | takes |
| --- | --- | --- |
| **auto** | detection's beacons, as today | `excluded` only; anything else is refused by name |
| **assisted** | detection's beacons (or `opts.beacons`, the card's area) less `beaconsOff`, plus `tips` | everything but nothing |
| **custom** | `tips` only - no beacon grid (detection still runs for the plate) | everything but `beaconsOff` |

**No feed is today, byte for byte.** `opts.feed` absent, `null`, `{}`,
`{ mode: 'auto' }` or `{ mode: 'auto', excluded: [] }` all take the old path
(support:feed 1). Measured side by side against claude-wip 1b45aec's file (the
files it loads with it taken from 1b45aec too): every no-feed build of the
coupon, the standing clamp, the shelf, the tab and the arc (its stair) - every
area bare, with the sheet, and as the card builds it on shared feet, the pads
by shareFeet, and the whole piece planned at once - 43 hashes, 43 the same (37
builds with a solid; 6 areas of the arc's that hold nothing, empty both
sides). The same run against 9a95297, before the rebase, was 32 of 32.

**A tip id** names a spot: `b` + a detected beacon's point, `u` + a given
tip's point as given, each coordinate to 0.01 mm (`NSO_SupportGridpack.tipId(p,
given)`), so it is the same in every build that has the spot. **A given tip** is
snapped to the nearest face of the piece within 1 mm and takes that face's
normal; from there it is exactly a detected beacon at that spot - the same
nudge, cap, sheet and gap. One on no face within 1 mm, or on a face turned up
more than 0.26 (the card's own Shift-click rule), is refused, reported in
`plan.feed.refused` and counted unsupported - never moved.

**Landing zones.** When any is given, a trunk lands on the plate only where its
CENTRE - the axis of its end - is inside a zone's circle; its pad and its
flared trunk (supports-foot) may spill past the line (owner's rule, after #274:
a flared foot is wider than a small zone). A member whose drop would land outside every zone
leans from its anchor, within the lean limit, to the nearest point of a zone it
can reach - its full lean then straight down, or one straight leg - clear of
the piece and of every other tree's members; a merge or a pickup that would
leave its member out of reach of every zone does not happen. **A merge or a
pickup that then lands in no zone is undone** (its node taken off its
branches; a pickup's stub's spot starts a strut of its own) **and its branches
land alone**, each the same way (`plan.unmerged`): the zone rule drops only a
tip that no zone takes by itself. A member of one tip that reaches no zone is
not built: its tip is counted unreachable and listed in `plan.offZone`. `plan.zones[i].trunks` names the trunks in each zone and
`plan.zonesEmpty` the zones nothing landed in - reported, nothing forced.
A trunk resting on the part (`restOnModel`) is not on the plate and is not
held to a zone.

**The eraser.** `excluded` names tips (left out, as `beaconsOff` does - "don't
support here": not built, and not reported unsupported either; listed in
`plan.excluded.tips`) and the branches and trunks of a previous build. The
plan is made, the members named are found in it by id, each one's polyline
becomes a **keep-out** (swept at its own side, starting 5 mm down from a tip it
held so that tip can lean away) that every leg of the next plan is tested
against as the piece is - detection never sees it - and the plan is made again.
So that member is not built; its tips are held by other members or reported
unsupported. A member that exists only in a build made after an earlier
erasure is found in the round after it. `plan.excluded` = `{ members, tips,
notErased, unknown }`: a pad or a sheet is not erased on its own
(`notErased`); an id that matches nothing is `unknown`.

**Members.** `shells(plan, parts)` (the card's build) answers with `members`
and `unsupported` beside the solids it always gave; `members(plan, parts)`
gives the same for any plan; `shareFeet()` answers with its pads as members.
The solids, the soups and the exported object are unchanged.

```
{ id, kind: 'tip' | 'branch' | 'trunk' | 'pad' | 'sheet', from, to, carries: [tip ids] }
```

- `from` / `to`: its top end and its bottom end. A tip's are its contact and
  the point under it on its column; a pad's and a sheet's, the middle of its box
  at its top and at its bottom.
- `carries`: every tip it holds up, sorted. A tip itself; a branch the tips
  above it; a trunk every tip of its tree; a pad the tips of the trunks on it; a
  sheet the tips under it (a stair: the tips it holds by itself too). **A held
  tip is in exactly one trunk's carries**; a tip that is not held is in
  `unsupported` (unreachable, inside the piece, refused).
- **A stair** (docs/SUPPORT-INTERFACE.md section 7): its own trunks (`tp.stairTrunks`,
  numbered after the plan's) are trunk members, and each tip the stair holds by
  itself (mode `drop`) is carried by one of them - the one whose spots on the
  strips come nearest it in plan, the lower number on a tie. Such a tip is still
  a tip member (its spot; `from` = `to`), and is no longer in its plan trunk's
  carries; a plan member that holds only such tips is not built and is not a
  member (trunkStepper's leftOut). A stair whose own tree was not built leaves
  its tips with their plan trunks.
- `id`: a tip's is its tip id; anything else's is its kind and an FNV-1a hash
  of what it carries and where it runs (its polyline to 0.01 mm; a pad's
  trunks; a sheet's tips and top) - the same in every build of the same inputs,
  a new one wherever the member is not the same member.

support:feed (27 checks): no inputs; custom on the clamp (one tip: one tree,
cut at the gap, 0.193 mm off the piece, its foot on the plate; two tips a
beacon pitch apart: one sheet across them); assisted on the coupon with every
other beacon off (no tip at an off beacon; every tip left on at its auto
contact, to the bit); landing zones on the shelf (a merge undone: every tip a
zone takes alone is held); the arc's stair (its two trunks named, its 38 tips
carried by them); an excluded trunk and tip on
the coupon, and a member of the rebuild excluded in turn; members the same
across two builds, every held tip in exactly one trunk (the arc's stair
included); the card's build's pads named by shareFeet.

## Paint scope: sub-region — inherited

Points come from `NSO_SupportBeacons.detect` with `opts.skipList` passed through
(a painted face still blocks what is above it but gets no beacon). This file names no faces of its own.
