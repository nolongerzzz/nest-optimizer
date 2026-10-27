# Support beacons — where a piece needs holding, on a plan grid from below

`nso_support_beacons.js` (`window.NSO_SupportBeacons`, and a Node module).
Test: `npm run support:beacons` (in `npm test`).

Engine only. `detectOverhangs` carries the beacons on every result. The grid-pack
planner (`docs/SUPPORT-GRIDPACK.md`) and the Supports card read them.

**Exposed only** (supports-exposed, narrowed by supports-followups): a beacon
counts only if the air at its spot reaches the outside of the piece; the inside
of a sealed cavity is left out. What lies under a spot is not asked: a shelf
over its own base, a bridge over its foot and the underside of an arch all get
beacons. See [Exposed only](#exposed-only).

---

## Why

`detectOverhangs` (`nso_support_aim.js`) flags whole triangles by one ray down
from each centroid and clusters them into regions with one marker each. That:

- **depends on tessellation.** One big underside triangle is one flag; a fine
  mesh of the same face is thousands. A triangle half over a boss is flagged, or
  not, whole.
- **misses things that have no triangle of their own.** A bridge is just a flat
  face. A downward edge between two printable faces isn't a face at all. A tip is
  a vertex.
- **gives the planner a region, not coverage.** Where in the region needs a
  contact is left to whoever reads it.

The direction is to over-support by default: detection has to find everything
that needs holding.

## What

```
NSO_SupportBeacons.detect(rawTris, { pitch = 3, ... })
  -> { ok, reason, beacons: [...], grid: { pitch, origin, nx, ny }, regions, counts }
```

A grid of whole `pitch` mm cells is laid over the piece's footprint, centred on
it. From each cell centre a ray goes straight up from below the plate and
crosses **every** surface on the way, not just the first. A depth count keeps
track of material. A downward-facing crossing met while the ray is in air is a
surface with something under it: either the plate or material, at a measured
gap. Equal-height hits are taken exits first, so an arm sitting flush on a
pillar has a gap of 0 and counts as resting.

### When a spot needs holding

Every candidate first needs air under it: a gap of more than `minDropMm`
(0.5 mm, the same value `detectOverhangs` uses). Below that, the face is resting.

| `need.kind` | rule |
|---|---|
| `face` | The face is steeper than the overhang angle, measured from the triangle normal: `n.z < -cos(45°)` by default. That's the threshold `detectOverhangs` and the slicers already use. Open to the plate below. |
| `gap` | The same steep face, but the air under it is bounded. Either there's material below (an undercut, a shelf over its own base, a tunnel's roof over its own floor; a sealed cavity's ceiling too, but that is interior and [exposed-only](#exposed-only) drops it), or the face is near-flat (≤ 10°) and anchored on both sides along x or y (a bridge) by a span wider than **5 mm**. A near-flat face anchored by a span of **5 mm or less is bridged and gets no beacon.** That's the one place this module decides something doesn't need holding. 5 mm is an assumed value, not a measured one; it sits well inside what slicers bridge unsupported. `opts.bridgeMm` changes it. |
| `edge` | A downward feature that no centre ray hits squarely. **(1)** Each cell's four corners are sampled too, as a shared `(nx+1)×(ny+1)` lattice. A corner whose crossing needs holding, where the centre has no downward crossing within one pitch in z, marks the cell. **(2)** Downward creases are sampled at half-pitch along their length. A crease is an edge whose two faces both face down, are more than 30° apart and both rise away from it, with the edge itself flatter than the overhang angle (a knife edge under two printable faces). |
| `tip` | A vertex lower than every neighbour and fully surrounded by downward faces, with air under it. |
| `ridge` | Ribs on a near-vertical feature (threads, fin stacks), where the face needs holding but there's no room to come up from below. That means material within **3 mm** under it (`ridgeGapMm`), the rib reaching no more than **3 mm** out from its wall (`ridgeReachMm`), and open air sideways. This gets a **side beacon**: its normal is the horizontal approach direction out of the wall, and it sits on the rib's underside **0.35 mm off the wall**. 0.35 mm is Bambu Studio's default support/object XY distance, so a side support placed at the beacon keeps the same clearance the slicer would. |

Creases and tips only add a beacon to a cell that doesn't already have one
within one pitch in z. A crease also has to hang in air: the surface the column
finds under its point must be one of the crease's own two faces. A face of the
piece within 0.01 mm of the crease point (a lid's edge sunk into the wall it
sits on) means the crease is buried, not a knife edge, and gets no beacon.

### Exposed only

A beacon counts only if the air at its spot reaches the outside of the piece.
It is **geometry only**: what is under the spot, the piece's own base or
foot or floor, is no part of the question. Reaching a spot with a support is the
planner's job (`docs/SUPPORT-GRIDPACK.md`, *Landing*): the plate first, led round
the piece within the lean limit, the piece itself only with `restOnModel`, and
what is still out of reach is counted *unreachable* and shown so on the card.

What is left out is the **inside of a closed piece**: cavity ceilings, and the
walls and floor of a sealed void. Their air has no way out, so they make **no
beacons and no areas**. Holding the inside of a piece is a later opt-in, not
this module.

The test is rays from the spot, along the piece's own triangles:

1. along its own normal, away from the surface: the common case, one ray. If it
   leaves the piece's bounding box without hitting the piece, the spot is
   exposed;
2. if not, a **fan** over the hemisphere the normal faces: 16 headings round the
   normal at each of **0.5, 5, 15, 30, 50 and 70°** above the face's own plane,
   the flattest first, because the way out of a shelf, a tunnel or an arch is
   nearly along the face. Any ray that leaves the box means the air has a way
   out; the beacon stays and is counted in `counts.sheltered`.

A sealed cavity has no ray out of it, so it cannot be taken for open.
`counts.interior` is how many candidates were left out. (A hit exactly on the
bounding box's own wall counts as a hit, not as leaving it.)

- It is asked of every beacon of every kind, at the moment the beacon would be
  added, so an interior spot never hides a real one in its cell
  (`cellHasNear`).
- Only the piece's own triangles count. Another piece in the way (an
  occluder) does not make a spot interior.
- A side (`ridge`) beacon's normal is its lateral approach, so the fan is
  taken round the approach direction.
- Cost: the piece's triangles are filed in a coarse xy grid (at most 128 × 128)
  and a ray is walked through the cells it crosses, so a near-vertical ray
  tests one cell. The fan is only drawn for a spot whose own normal is blocked
  (96 rays at worst, and all 96 for a sealed cavity). The 30,912-triangle
  threaded shank still runs in about 2 s.

**What this decides, stated plainly.** Detection no longer depends on what is
under a spot. A cap over a wide stem of the same piece, a shelf over a lower
ledge, a floor above a chamfered base, the underside of an arch over its own
floor: each is a beacon, because air runs out from under it. Whether a support
can get there is the planner's: usually only the ones near an edge can be led
round the piece to the plate; the rest are reachable only by resting on the
piece (`restOnModel`) and are otherwise counted *unreachable*.

**Limit.** A fan is a sample, not a proof. A long, thin passage that is neither
along the spot's own face nor wider than about 1/115 of its length could slip
between the rays and be counted interior. The flat headings (0.5°) catch every
tunnel that runs along the face, which is what a shelf, a bridge, an arch or a
through-bore is.

How the wall is found for a side beacon: the lateral normal comes from the
horizontal part of the face normal. For a flat rib underside, which has no
horizontal part, it comes from the nearest wall's normal along ±x/±y instead.
From the cell's point the scan walks inward along −normal in 0.05 mm steps while
the underside continues with air under it, then refines the root by bisection.
The beacon goes 0.35 mm back out from that root.

### A beacon

```
{ x, y, z, normal, need: { angle, gapBelow, below, kind, ... }, cell: [i, j], tri }
```

- `z` is **on the surface**. The interface offset is the planner's job.
- `normal` is a unit vector pointing from the surface toward where a support
  comes from. For most beacons that's the face's outward normal; for a side
  beacon it's the lateral approach direction (`n.z = 0`).
- `need.angle` is the surface's tilt off horizontal in degrees. `need.gapBelow`
  is the air under the spot in mm. `need.below` is `'plate'` or `'material'`.
  Gap beacons over a bridge add `spanMm`. Side beacons add `side`,
  `standoffMm` and `wallMm`. Corner beacons add `corner` and `via` (the kind the
  corner itself would have been).
- `tri` is the piece's triangle the beacon sits on. It's for diagnostics: the
  only number in the record that depends on tessellation.

Each cell gets one beacon per exposed crossing that needs holding. (A sealed cavity's ceiling over an overhanging floor used to give two beacons in
one cell; the ceiling is interior, so it gives one. A tunnel's ceiling over the
tunnel's own floor is exposed, so a spot under it and the floor's own
overhang, if it has one, both stay.)

### Regions

Beacons in 8-adjacent cells within 1.5 pitches of each other in z form one
region. Two beacons in the **same** cell are never joined through that cell, so
a floor and the ceiling above it stay separate. `region.point` is the centroid
of the beacons and `region.beacons` lists them; `count`, `cellCount`,
`planAreaMm2`, `kinds`, `min`, `max` and `spanMm` are also there.

## detectOverhangs: the wrapper, and one deliberate deviation

The ticket asked for `regions` to become the connected beacon cells, with
`detectOverhangs` as a thin wrapper and **nothing else changing behaviour**,
and the existing suites staying green. Those requirements can't all hold at
once. The existing suites pin numbers that only the triangle pass produces:
`trisDownward`, `trisFlagged`, `trisOnPlate`, the cantilever's 200 mm² region
centred at `[20, 5, 16]`, and the tape part's 1187.86 mm² region. The tree's
contact lattice is built from `region.tris`, and `tree:reference` holds it
within 15% of a real Bambu tree. Replacing `regions` would move every one of
those.

So `detectOverhangs` runs both:

- the triangle pass, **unchanged**. `regions`, `tris`, `areaMm2`, `point`,
  `normal` and the counters are the same numbers as before.
- the beacon grid, with the same angle, plate, minimum drop, paint and
  occluders, attached as:
  - `det.beacons`, `det.grid`, `det.beaconRegions` (the beacon regions described
    above), and `det.beaconsReason`;
  - `region.beacons` on each triangle region: the beacons that sit on that
    region's own triangles.
- `opts.beacons: false` skips the grid. `opts.beaconPitch` and `opts.bridgeMm`
  are passed through.
- If `nso_support_beacons.js` isn't loaded, `beacons` is `null` and
  `beaconsReason` says so. It never claims "nothing found".

Switching the planner over to read `beaconRegions` / `beacons` instead of
`regions` was the follow-up ticket. It is done (supports-exposed): the grid-pack
planner's adapter calls `NSO_SupportBeacons.detect` directly, and the tree
suites' numbers were re-pinned once, with the reasons in their comments. The
triangle pass above is unchanged.

`index.html` loads `nso_support_beacons.js` before `nso_support_aim.js`. The
support, tree and assemble suites now load it as well, so they run through the
wrapper.

## Paint

`opts.skipList` is read the same way `nso_support_aim.js` reads it. A crossing
on a painted face still counts as material and blocks whatever is above it, but
it gets no beacon. `detect()` treats a missing list as `[]`, and a `null` list
is refused by name. `detectOverhangs` keeps its rule that there's no unpainted
default and refuses before the grid runs.

## Evidence (`support:beacons`, 45 gates)

All fixtures are generated in the test.

| fixture | result |
|---|---|
| Tilted box, 40×30×10, underside at 30° off the plate, lowest edge on the plate | Every cell whose centre is over the face and more than 0.5 mm up has a `face` beacon: 120 of 120, none stray. Count is **120 against 115.5** (the face's 1039.2 mm² plan area / 3²), **+3.9%**. The run along the slope is 34.64 mm, 11.5 cells, so depending on footprint alignment the grid holds 11 or 12 columns: 110 (−4.8%) or 120 (+3.9%). Every beacon is on the face (`z = x·tan 30°`), at angle 30°, with the face normal. |
| Same box, underside cut into **2 / 200 / 2048** triangles | **120 / 120 / 120** beacons. The same beacons cell by cell, worst difference 1.1e-6 mm (that's float32 noise in the subdivided plane). |
| Shelf (the tree suite's 12×10 arm at z 16) | All 16 cells under the arm: `face` at z = 16. 3 `edge` corner beacons are next to the post. One region. |
| 20 mm bridge | All 24 cells under the span: `gap`, each reporting `spanMm` 20 and a 10 mm drop. Nothing on the pillars. |
| 4 mm bridge | **0 beacons** (bridged). With `bridgeMm: 3`, 4 `gap` beacons. |
| Mushroom (probe fixture, and cap flush on stem) | Every cell under the cap ring has a beacon at z 20 (12/12). **None inside the stem** and none below z 20. The probe fixture adds 4 corner `edge` beacons next to the stem. |
| Threaded shank, generated (r 5 / 6.2, pitch 2, 39.8° flanks, 30,912 triangles) | 37 `ridge` beacons. **Every inner turn (8 of 8) has them in all four quadrants.** Every normal is horizontal and points out of the shank. Every one sits at radius **5.358**, i.e. 0.35 mm off the root plus facet error. The first, partial turn is over the plate and gets 2 `face` beacons, which is correct: a support from below fits there. |
| Box with a 10×10 through-hole | On the plate: **0 beacons**. Lifted 6 mm: 84 `face` + 12 `edge`, all on the underside at z 6, **none in or on the hole**. |
| Hollow block lifted 5 mm (10×10×4 cavity) | Each of the 9 cells over the cavity holds **one** beacon: the underside (`face`, z 5). The cavity ceiling (`gap`, z 12) is interior and counted out; one region. *(Two beacons and two regions before exposed-only.)* |
| `library/box_closed.stl` (a base with a sealed 26 × 36 cavity under a lid) tilted 30° | **1 area, the underside: 238 `face` beacons**, none on the cavity (all 12 of its faces checked by triangle), every one with a way out along its normal (brute force). Stood flat: 0 beacons (276 before: the cavity). |
| `fixtures/box_open.stl` (the same cavity, top off) tilted 30° | The same 238 beacons in one area; none on the cavity's walls. Flat: 0. |
| Bracket: base slab, post and a 24 × 10 shelf whose underside (z 16) hangs 12 mm over the base (supports-followups) | 35 beacons in one area: 32 `gap` + 3 corner `edge` beside the post, all at z 16, **all with their own normal blocked by the base** (`counts.sheltered` 35), all with air running out along ±y (brute force). None before: the base below was "more of the same piece". |
| 20 mm beam on two piers over its own floor | 28 `gap` beacons, `spanMm` 20, all sheltered. |
| Round-roofed tunnel (D-shaped bore, r 10, floor at z 3) through a 40 × 30 × 24 block | 40 `gap` beacons on the roof, all sheltered. |
| The Supports workflow's tunnel block (40 × 40 × 30, bore 16 × 12 along y, ceiling z 20) | 84 `gap` beacons at 3 mm in one area, all sheltered; the planner holds 25 of them and counts 59 *unreachable from the plate* (section 9 of `support:workflow`, default settings). |
| A solid block with a sealed 20 × 6 × 10 cavity | 0 beacons; 28 candidates counted interior. |
| Knife edge, faces 60° off the plate (printable on their own) | 10 `edge` beacons along the edge (one per cell), nothing else. |
| Inverted pyramid, tip at z 8 | 1 `tip` beacon. |
| Paint | Painting the shelf underside removes all of its beacons. |
| `detectOverhangs` wrapper | Cantilever region still 200 mm² at `[20, 5, 16]`. 28 beacons ride along, all on that region's triangles. `beacons: false` skips the grid. |
| `fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 32,862 triangles | 140 `face` + 33 corner `edge` beacons in about 0.3–0.6 s. 161 of them are inside the on-edge underside that `detectOverhangs` reports as its biggest region. |

### Against Bambu

On the user's tilted box, Bambu's own tree put 437 contacts on about 6600 mm² of
overhang, roughly a 3.9 mm equivalent pitch. Its normal supports run 2.9 mm lines
under the full projection. At the 3 mm default this grid places one beacon per
9 mm² of plan, about 730 on that area. That's deliberately denser than the tree,
and about the same as normal supports. The user's fixture STL and the two G-code
files are in the ticket thread and aren't in the repository, so that figure
hasn't been run here.

## Footprint (supports-footprint)

A beacon is a sample, and the cell it was found in is not the surface it holds: a spot found by a corner of its cell sits on the
very edge and the rest of the cell is air. `detect()` can trace the surface itself, area by area (`opts.footprint === true`, or
`opts.insetMm > 0`): `region.footprint = { loops, areaMm2, stepMm, insetMm }` - the loops of the surface's edge (outer
counter-clockwise, a hole clockwise), found on the columns of the piece, not on the grid - and, with `opts.insetMm`, a face, gap or
corner spot nearer the edge than that is moved in (`beacon.moved`, `beacon.clearMm`). Off by default, so the spots and the
planners' pins are what they were; the Supports card asks for both. A third option, `opts.seedPitchMm` (the card: 1 mm), is a **finer look**: the grid
steps over what is narrower than its pitch (a 0.6 mm ledge in 5 of 12 alignments, a Negative Sphere's 3 - 4 mm apex not at all), so after the footprints are
traced `detect()` samples again at that pitch and a surface that needs holding (and hangs 2 mm or more) that no footprint holds becomes a **seed** beacon
(`need.seeded`; `counts.seeded`) of an area of its own - unless it lies within 3 mm of a footprint at its height, which is the grid's own rim. Nothing is
seeded on the four heads, the clamp or the wedge. `NSO_SupportBeacons.footprintsOf(regions)` gives the loops as plain data for the sheet's fill.
`docs/SUPPORT-FOOTPRINT.md`, `npm run support:footprint`.

## Stated, not measured

| value | default | why |
|---|---|---|
| `pitch` | 3 mm | The ticket. Denser than Bambu's tree. |
| `angleDeg` | 45° | `detectOverhangs` and slicer default |
| `minDropMm` | 0.5 mm | `detectOverhangs` |
| `bridgeMm` | 5 mm | Comfortably inside what slicers bridge; errs toward support |
| bridge tilt | ≤ 10° | Only a near-flat face is a bridge |
| `ridgeGapMm` | 3 mm | Less room than this under a face means no support from below |
| `ridgeReachMm` | 3 mm | A rib longer than this is an overhang, not a rib |
| side standoff | 0.35 mm | Bambu Studio's support/object XY distance |
| crease | ≥ 30° | Faces closer than this are one curved surface |

## Out of scope

- **The planner's choice of what to do with a beacon.** The grid-pack planner
  reads `beacons` / `beaconRegions` (it no longer reads `detectOverhangs`'
  triangle `regions`); the triangle pass is kept for G-scope's markers and the
  numbers the aim suites pin.
- **Lateral openness for side beacons** is one horizontal ray of 6 mm. A rib
  facing a second wall more than 6 mm away still counts as open.
- **Bridge span** is measured along x and y only. A bridge laid diagonally reads
  the longer of its axis spans and errs toward support.
