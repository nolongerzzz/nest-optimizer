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
| foot pad | one first layer (0.2 mm), `r = max(3 mm, 2.5 × the trunk's half-width)` | §2, *Feet* |
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

**Feet.** Every trunk that lands on the plate stands on a pad: one first layer
(0.2 mm, `opts.firstLayerMm`) of a round slab at the plate, `r = max(3 mm, 2.5 ×
the landing member's half-width)` (3 mm for a 1.2 mm strut and for the
capped 2.4 mm trunk; 3.75 mm for a lone 3 mm strut; 7.5 mm for a 6 mm trunk).
Pads of trunks that stand close overlap and are **unioned**: the trunks in one
solid are joined through them (98 trunks of the 30° closed box became 10
solids). Where several pads ring a gap the union has a hole in its first layer,
a handle by Euler count (6 of them on that box); the trunks alone have none.

- **Nothing below z = 0.** The pad's bottom *is* the plate; the trunk's
  end cap sits half a layer inside the pad (so it is never coplanar with the
  pad's bottom, the one input the boolean cannot be trusted with). A member
  whose last leg would reach the plate leaning stops 1 mm short and drops the
  rest straight, because a leaning cap's low corner goes under the plate.
- **Clear of the piece.** A pad's corners are drawn in wherever the piece (or an
  occluder) stands within 0.2 mm of its slab, found with horizontal rays at four
  heights from the landing point, so a foot never fuses a support to the part's
  own first layer (measured 0.256 mm from the piece on the closed box).
- `opts.footPads: false` leaves them off (the suites that weigh members and
  bores on their own use it, with the reason in each).
- Pads are only for trunks that land on the plate. A resting trunk keeps its
  two-layer pad on the part.

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
| `building` | `parts()`: trunks swept / trunks | `done` / `total` |
| `welding` | `weld()`: the unions | none: how many joins there will be is not known until the last is done |

A phase with no count says so with nulls; no total is ever guessed. `done` never
goes down within a phase and never passes `total`. Between units the last message
is repeated once 200 ms (`HEARTBEAT_MS`) has passed, and `beat()` does the same
from inside the steer, nudge and merge loops, so the gap between messages is at
most 200 ms plus the longest single call that does not beat - the first detect
and index of a piece, `padGaps`, one wasm union. A callback that throws is
ignored.

`solid(plan)` is two calls now: `parts(plan, opts)` (the BUILDING half, a trunk
at a time, with `opts.yieldFn` given a turn between trunks) then
`weld(plan, parts, opts)` (the unions, with `yieldFn` after each). `solid` with
no callback and no `yieldFn` is the same bytes as before: it runs the sync
`trunkParts`, which `parts()` shares with it, then `weld`. The Supports card calls
`parts` (in its worker) and `weld` (on the page) itself, so it can run every area
through one phase before the next and keep one bar.

## 3. Measured (`support:gridpack`, 80 checks; `support:exposed`, 114)

| fixture | result |
|---|---|
| **tilted box 30°** (40 × 12 × 6 on its edge) | 44 of 44 held (the detector's beacons; the lattice gave 50), 26 trunks, all on the plate, no refusal; 12 pickups, 5 merges; every leg within 30°; mesh_validate clean, one shell per solid |
| **closed hollow box, 30°** (`library/box_closed.stl`) | `support:exposed`: **1 area, 238 beacons, 238 held** on 98 trunks (62 merges, 78 pickups), none unreachable; worst leg 29.8°; no beacon on the cavity; 98 trunks on feet join into 10 solids with no handle (Euler 20; 6 before the pads' gaps were filled), nothing below z = 0, 0.256 mm from the piece |
| **flat shelf, 3 × 3** | 12 beacons (9 face + 3 corner `edge` beside the post, which the lattice could not see); 3 first merges, each at the predicted level (within 0.1 mm); every merge 2 members except one of 3 |
| **box with a through-hole** | 26 of 26 held (the arm's whole underside, since supports-followups; 9 of 9 before); 25 steered; 22 trunks, each in the hole or beyond the block's edge, none through the block; every last run upright |
| **mushroom on a wide stem**, rest OFF | 12 of 12 cap points *unreachable from the plate*, nothing built, no refusal |
| same, rest ON | 12 of 12 *resting on the part*, on the stem top (z 6), pad at 6.18 |
| **boss** | **28 of 28 held** (trunk-first: 24); 4 trunks, all to the plate; tips moved off the boss and post |
| **60 mm overhang** | 28 of 28 on **one trunk**, its section capped at 2.4 mm (4 × the strut area) |
| **Generate twice** | identical bytes (2,936 triangles on the boss) |
| strut style | no merges or pickups: 9 posts for 9 points |
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
  for; `opts.firstLayerMm`), `max(3 mm, 2.5 × half-width)`, a 48-sided disc
  drawn in 0.2 mm off the piece. The ticket's numbers except the thickness and
  the 0.2 mm clearance.
- **FLAG** exposed-only keeps an overhang that has more of the same piece
  directly below it (supports-followups; docs/SUPPORT-BEACONS.md, *Exposed
  only*): a cap over a wide stem, a shelf over its base, an arch over its floor
  all get beacons, and the planner decides what the plate can reach. The
  ones it cannot reach are counted unreachable; they cost the planner about a
  third of a second each to give up on (the 59 of the workflow's tunnel: 25 s).
- **FLAG** a fan of rays is a sample, not a proof, that a spot's air reaches the
  outside (docs/SUPPORT-BEACONS.md, *Limit*).
- **FLAG** foot pads: a gap is filled and a touch bridged by raster and a
  rule of thumb (0.025 mm cell, 0.1 mm touch), not by an exact polygon union; a
  pad void narrower than a cell and not at a touch could survive as a handle.

- **FLAG** square section everywhere; area cap 4 × s²; merges of up to 3.
- **FLAG** pickup reach = 1.05 × the pitch; the stub's vertical last run is 2 × s.
- **FLAG** resting pad: 0.4 mm, a 0.18 mm gap above the surface (a floating
  first layer, as slicers print support-on-model).
- Hollowing bores only merged members at the default size: a single 1.2 mm
  strut would leave 0.36 mm, which no slicer keeps.
- Ray tests on leaning legs are brute force. Steering is cheap on these
  fixtures (the suite runs in about 35 s); a 30k-triangle part wants the 3D
  index `docs/CURVED-BRANCH.md` §2b names.
- Out of scope, as asked: economics dials beyond L, curved legs, UI, GRISPR.

## Paint scope: sub-region — inherited

Points come from `NSO_SupportBeacons.detect` with `opts.skipList` passed through
(a painted face still blocks what is above it but gets no beacon). This file names no faces of its own.
