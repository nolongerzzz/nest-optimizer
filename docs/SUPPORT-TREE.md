# Support tree — a trunk that stops, and branches that finish the job

`nso_support_tree.js` (`window.NSO_SupportTree`, and a Node module).
Tests: `npm run tree:test`, `npm run tree:canonical`, `npm run tree:reference`.
All three are in `npm test`.

Loaded by `index.html` and **not wired to any button**, which is the same
order `nso_support_aim.js` and `nso_path_sweep.js` landed in: the module, the
suites and the write-up first, the UI entry point as its own change.

It builds the structure `docs/SUPPORT-AIM.md` named as the next ticket and
`docs/CURVING-PATH.md` named the caller for:

| stage | what it is | who does the work |
|---|---|---|
| **trunk** | the existing straight-line auto-aim, stopped at a **computed split point** instead of at the overhang | `NSO_SupportAim.aim`, unchanged, handed a different target |
| **branches** | one per contact point the overhang actually needs, each an independent sweep from the trunk's end to its own point | `NSO_PathSweep.sweep`, a two-point path |
| **union** | one solid, not a pile of solids in contact | `NSO_unionSoups` (`app-join.js`) |

Nothing here asks how many branches to make or where to put them. Both come
out of the overhang's own geometry and out of two constants measured off a
real Bambu slice.

---

## 1. The audit that came first

### It matches the interface-physics finding, and the finding is measurable

The claim to confirm was *bulk trunk, isolated point-contact branch tips*.
`npm run tree:reference` does not confirm it from a note — it reads it back
out of `fixtures/3mf/tabletop.gcode.3mf`, a real Bambu Studio slice of a 70 mm
tabletop on tree supports (202,877 moves, already parsed end to end by
`gcode:lines` and `gcode:zfilter`), on every run.

Each `Support` / `Support interface` layer's extrusion moves are clustered
into connected components — two moves are one island when their segments come
within 1.5 extrusion widths in XY. The island **count** per layer is therefore
the number of separate things the support consists of at that height, which is
the trunk-then-branches question asked of the print rather than of a picture
of it.

| z | islands | phase |
|---|---|---|
| 0.30 | 18 | the base pads |
| 0.60 → 4.50 | **36 on every one of 14 layers** | the **trunk** phase — the count does not move |
| 4.80 → 19.20 | **36 → 451**, climbing | the **branch** phase |
| 19.50, 19.80 | `Support interface` | a perforated sheet at a ~1.09 mm line pitch over 69.9 × 69.9 mm |

So the observed pattern is exactly the one described: 36 trunks carry the load
for 4.2 mm without splitting, then fan out to 451 tips — **12.53 branches per
trunk** — and those tips carry one continuous interface.

`fixtures/3mf/supportwithinsupport.gcode.3mf` is the same thing from the other
end, and the check reads it too: **no `Support` feature at all**, two
`Support interface` layers, the lower one **22 separate contact patches** and
the upper one **a single sheet lying on them**. Isolated point contacts
carrying a continuous interface, as a measurement.

The interface line pitch that falls out of the tabletop file — 4,495.9 mm of
extrusion over a 69.9 mm span, ~64 passes, **1.09 mm** — is the same figure
`docs/SKIN-CROSSHATCH-PITCH.md` already arrived at from Bambu's own settings
(0.61 mm rib + 0.5 mm gap = 1.11 mm), reached independently from the toolpath.

### What "a contact point to avoid sag" means geometrically

It is a **covering** question, not a beam-deflection one. The overhang droops
wherever it has to span too far between the things holding it up, so the
contacts have to be placed so that no point of the region is further than the
covering radius from one. That is the whole of it, and it is why this module
computes a covering radius and **measures the one it achieved** rather than
integrating anything.

### The raster-tracer's sag math does not apply, and that needed settling

The ticket asked whether the bridging/sag work in the raster tracer could be
reused rather than re-derived. It cannot, and the reason is worth writing down
so the next ticket does not go looking again.

`nso_raster_lines.js`'s **bridge** (`collapseBridges`, `BRIDGE_STROKES`, the
`bridge <= w / sin(t)` bound at its line 477) is a **skeleton** bridge: the
one-pixel stub Zhang-Suen thinning leaves where two drawn strokes cross. It is
measured in pixels of a source image, its bound is the width of the rhombus
two strokes make at angle `t`, and it is about reading an X as an X instead of
as an H. It says nothing about molten filament over air. The word is shared;
the mathematics is not, and reusing it would have been a pun.

The only other bridging statement in the repo is `nso_skin.js`'s free-layer
note — *"the sheet bridges from tip to tip, so its first layer prints over
air"* — which is explicitly marked **stated, not measured**.

What **is** reused is `nso_support_aim.js`'s own `region.spanMm`, which its
OUT OF SCOPE 4 reports and explicitly declines to take a view on: *"callers
wanting it gate on `region.spanMm` themselves; detection reports the span and
takes no view."* This module is that caller, and the view it takes is a
number, below.

**And the reference does not contain a max-unsupported-span either**, which is
worth stating because it is the number a caller would expect to find. Bambu
never lets anything span air: the `Bridge` moves in the tabletop file are
67.3 mm long, and every one of them is bridging **over the support interface
sitting directly beneath it**, not over nothing. What the reference gives
directly is a contact **pitch**, so a pitch is what this module uses.

---

## 2. The two constants, and why they are not settings

Both are measured off the reference, and `tree:reference` takes both of them
out of the G-code again on every run and fails if this file and the file it
was measured from have parted company.

### `MAX_SPAN_MM = 3.29` — the span allowed between contacts

The reference's final support layer puts **451** contact islands under a
**4,892 mm²** footprint. The **areal pitch** — the side of the square cell
each contact has to itself — is

```
sqrt(4892 / 451) = 3.2936 mm
```

Nearest-neighbour spacing over the same 451 islands is 1.77 mm at its
tightest, **2.36 mm median** and **3.94 mm** at its worst, so the areal figure
sits inside the range the structure itself uses. Areal pitch is the right
statistic to compare a square lattice against: a regular lattice's nearest
neighbour *is* its pitch, while an irregular field's nearest neighbour sits
below its areal pitch. Both are asserted.

### `BRANCH_TILT_DEG = 31.44` — how far a branch may lean

Measured per tip, as the angle off vertical from that tip to its nearest trunk
over the 15.0 mm rise between the two phases:

| | median | p95 | max |
|---|---|---|---|
| branch lean off vertical | 18.19° | 26.83° | **31.44°** |

31.44° is the widest the proven structure ever leans, so it is what this
module allows — **not** the 45° printable angle `detectOverhangs` flags
overhangs at. 45° is kept as the **ceiling**: a caller asking past it is
refused by name, because a branch leaning further than that is an unsupported
overhang by this repo's own detector, and a support that needs support is not
a support. The ceiling is read from `NSO_SupportAim.ANGLE_DEFAULT_DEG` rather
than restated, and the suite asserts that.

---

## 3. The contact points

A square lattice at exactly the span, centred on the region's own bounding
box, clipped to the region, then topped up until the covering radius is
achieved rather than hoped for.

**The lattice is laid at exactly the pitch, centred.** With a footprint `w`
wide, `ceil(w / p)` sites spread symmetrically about the centre leave at most
`p` between neighbours and at most `p/2` between the outermost site and the
edge. Centred rather than packed from a corner, so a symmetric region gets a
symmetric answer — anchored at min-x, a mirrored piece would get a different
tree. Pinned in the suite on the shelf fixture: 4 × 4 sites, nearest-neighbour
spacing exactly 3.290000 mm everywhere.

**A region narrower than one span gets exactly one site, at its centre.** That
degeneracy is what makes this a superset of `nso_support_aim.js` rather than a
replacement: one contact means no split, no branches, and the result *is* the
single straight strut. `planTree` returns it as such, with `single: true`,
rather than as a tree with an empty branch list dressed up.

**A site lands on the region by vertical projection.** Every region triangle
satisfies `n.z < -cos(angleDeg)` by construction — that is what flagged it —
so none is anywhere near edge-on and all project onto XY without degenerating.
Where several cover one site, the **lowest** is taken: a support arriving from
below meets that one first.

**The covering radius is `p / √2`, not `p / 2`.** The farthest a point can be
from every site of a square lattice is the centre of a cell — half the
diagonal, **2.3264 mm** at a 3.29 mm span. Half the pitch is the gap between
*neighbours*, which is what the reference was measured as. Conflating the two
would have the lattice failing its own covering test at the centre of every
cell it lays.

**The top-up is what makes the covering a fact**, and the sampling is what
makes it honest. The region is sampled at its triangles' vertices plus a
barycentric grid over each of them at half the span; every sample is measured
in 3D against the contacts already placed; the farthest uncovered one becomes
a contact; repeat. A flat rectangular region arrives as **two triangles**, so
vertices and centroids are six points, none of them in the middle of a lattice
cell — the coverage figure would have been measured where it is best and
reported as if it were measured where it is worst. Measured over 121 samples
instead, the shelf's lattice comes back at exactly `3.29 / √2 = 2.3264 mm`.

`coverageMm` is reported whatever happens, so a caller is never asked to take
the covering on trust, and a region that cannot be covered inside
`maxContacts` is **refused by name** rather than half-covered.

---

## 4. Where the trunk stops

As high as it can. The trunk is the load path, so every millimetre it climbs
is a millimetre no branch has to carry; the constraint is that once it stops,
**every** branch it hands off to must still stand within the tilt. Raising the
split point shortens the rise the branches fan out over, so the widest branch's
tilt grows — and the split point is the highest station at which the widest one
is still inside the limit.

**Found by scanning the line, not by bisection.** As the split point climbs it
also moves sideways toward the fan's centre, so the widest branch's tilt is not
monotone in the trunk length and a bisection would be quietly answering a
different question. The scan's resolution is reported as `splitResolutionMm`
(2048 stations; 0.0078 mm on the shelf) and the suite re-runs at 4096 stations
and pins the two together.

On the shelf fixture the split lands at 4.578 mm — 28.6% of the way to the fan
centre — and the widest of 16 branches then leans **31.4263°** against the
31.44° limit. That is what "as high as it can" means, stated as a measurement.

**A contact on the trunk's own axis is the trunk's, not a branch's.** A
symmetric region with an odd lattice count puts one contact dead on the aim
every time, so this is the ordinary case. Built as a branch it would be a
prism coaxial with the trunk, its four side walls exactly coplanar with the
trunk's, and the boolean handed two coincident coplanar walls emits slivers:
measured, before this existed, as 2 degenerate triangles and 2 non-manifold
edges that no weld tolerance removes. So the trunk grows past its split point
to reach it and the fan is the rest. The split point is still where the fan
leaves, which is the thing that was computed.

**When no station works, it refuses and says how many trunks the region would
need.** That is the honest answer and the reference agrees with it: one trunk
cannot serve a 70 mm tabletop, which is why the real slice used 36. Put the
reference's own footprint through `planTree` and it refuses at 68.54° and asks
for **25** trunks against the slicer's **36** — the same order, from a
deliberately crude square-cell estimate.

---

## 5. The branches

A two-point sweep each. One segment, no joints, so `NSO_PathSweep`'s mitre
arithmetic never runs and the cross-section is exact along the whole branch
for the same reason Extend's is. 16 triangles: 2 × 4 walls, plus a 4-triangle
fan at each cap.

The profile is the **square the trunk already settled on**, so trunk and
branch have one cross-section and one wall-thickness floor between them —
`NSO_Thickness.floorFor`, through `NSO_SupportAim.buildStrut`, as the only
source, exactly as before.

### Why `NSO_PathSweep` and not Extend

`docs/CURVING-PATH.md` named this caller: *"the branching ticket … should call
`NSO_PathSweep` rather than grow anything itself."* The reason is Extend's own
OUT OF SCOPE 5 — it refuses an off-cardinal axis — and a branch leaves the
trunk on one by definition. The refusal when the module is absent says so.

### Each branch leaves the trunk on its own side

The root is sunk **one cross-section** back along the trunk (so the union has
a solid overlap to work on rather than two caps meeting on a plane of zero
thickness) and moved **0.4 × side across it**, along the branch's own heading.

This is not cosmetic, and it was not in the first version. With every root on
the axis, any two branches share a start point, so their side walls meet along
a curve that pinches to nothing exactly there — and `manifoldToSoup` writes
the result as float32, whose spacing at plate coordinates is about 2 × 10⁻⁶ mm.
Two vertices of that pinch land on the same float32 and the boolean's output
carries a triangle with a **repeated vertex**. Measured on the three fixtures:

Measured on the three multi-branch fixtures, through the shipped boolean, at a
weld fine enough not to be the thing under test (1 × 10⁻⁶ mm):

| | roots on the axis | roots spread 0.4 × side |
|---|---|---|
| shelf (16 branches) | 0 degenerate, 0 non-manifold, Euler 2 | 0, 0, Euler 2 |
| tall (28 branches) | 2 degenerate, 6 non-manifold, Euler 5 | **0, 0, Euler 2** |
| tab (8 branches) | 1 degenerate, 2 non-manifold, Euler 3 | **0, 0, Euler 2** |

The shelf is clean either way, which is exactly why this had to be measured on
more than one fixture: whether two particular branches pinch depends on how
their walls happen to meet, so one clean case proves nothing.

0.4 is under the 0.5 half-width, so the root's centre is still inside the
trunk's own cross-section — which is the bound that matters. At 0.45 the
fixtures start reporting a piercing pair instead, measured the same way.

### The clearance test is run on the rails, not just the axis

`nearestBase` tests one centre line. That is the right test for choosing
between bases and too little for a solid 1.2 mm across: a branch threading a
gap narrower than itself has a clear centre line and a body through the wall.
`NSO_PathSweep` already built the four rails the solid is made of, so those are
what get cast — the axis plus rail *j* from ring 0 to ring 1, **five rays**,
and the branch stands or falls on all five. The rails are the real ones, not a
circumscribed cylinder that would refuse branches that fit.

The suite builds the case rather than describing it: a 0.5 mm plate across one
branch this planner really produced, with a **0.8 mm square window centred
exactly on its axis**. The axis goes clean through (`nearestHit` returns −1);
the rails do not, and the refusal names the rail and the distance.

**The rails are tested over the shaft — the last cross-section is left out.**
That is not a softened gate, it is the only coherent one: the cap is flat and
perpendicular to the branch, the face it lands on is not, so on any oblique
branch the leading rails stand proud of the target **by design**. Measured
before this exclusion existed, *every* branch on all three fixtures was
"blocked 0.4 mm short" — by the overhang it was aiming at. What the cap does in
that last cross-section is `tipPenetrationMm`'s business.

### The flat cap, again

Every branch reports `tipPenetrationMm`, measured off the finished solid
against the region's own normal, exactly as `nso_support_aim.js` reports it for
the strut. The closed form there is `(side / 2) × sin(tilt)` because the
strut's cap meets the surface edge-on; here the frame comes from
`NSO_PathSweep`'s transport, so the extreme point is somewhere between the
edge midpoint and the corner. The suite asserts the **bracket**

```
(side / 2) × sin(tilt)   ≤   tipPenetrationMm   ≤   (side / √2) × sin(tilt)
```

for every branch, which is the honest statement. Worst measured: **0.3878 mm**
on the shelf, at a 27.24° lean. `opts.tipEngageMm` pulls every tip back off the
surface by the same name and the same sign `aim()` already uses.

### An alternate tip: `branchStyle: 'gecko-hand'`

A **shape option only**. `opts.branchStyle` is `'square'` (the default, and
everything above) or `'gecko-hand'`; anything else is refused by name.

**What the default tip actually is.** The audit that came first here:
each branch is `NSO_PathSweep.sweep` over a two-point path with
`squareProfile(side)`, a 4-vertex square of the trunk's own `sideMm`
(1.2 mm, floored at 0.42). It ends in the sweep's flat end cap, which is
perpendicular to the branch and fanned from the path endpoint. That makes
16 triangles per branch. The trunk is `buildStrut`'s square prism, with the
same flat end.

**What `gecko-hand` changes.** Nothing that decides the tree. The contacts,
the split point, the trunk, each branch's root, heading, length and tilt, and
the refusals are all settled before the style is read. The square shaft is
still built, byte for byte, flat cap included. The style then **adds** a hand
at every contact point: at each branch tip, and at the trunk's tip when the
trunk ends on a contact (the single strut, or the carried one).

| `GECKO.` | value | what it sets |
|---|---|---|
| `FINGERS` | 5 | fingers per hand |
| `FAN_DEG` | 216 | the arc they splay over, centred on the branch's outward lean (a vertical tip has no lean and gets the full circle) |
| `KNUCKLE_SIDES` | 1 | how far back down the shaft they leave it |
| `REACH_SIDES` | 1 | how far from the contact the fingertips land, **in the plane of the supported surface** |
| `ROOT_SIDES` | 0.1 | root offset off the shaft axis toward the fingertip |
| `WIDTH_SIDES` | 0.5 | hexagon across-flats, never under the wall floor (0.6 mm on the fixtures, floor 0.42) |

Each finger is one more two-point `NSO_PathSweep` with a regular **hexagon**
profile: one segment, no mitre, an exact section, 24 triangles. Fingers are
separate parts that go through the same `NSO_unionSoups` fold.

- **The fingers go on after every shaft.** The fold is left to right, so the
  union's first `1 + branches` steps are the default tree's own steps. With
  the fingers interleaved instead, `tall` picked up 2 piercing pairs down at
  the branch roots, nowhere near a hand. The only change was the order in
  which the boolean re-rounds to float32.
- **A finger's root cap sits inside the shaft, not just its centre.** At
  `ROOT_SIDES` 0.25 the cap reached 0.646 mm on a 0.6 mm half-width. The
  union on `shelf` then carried a vertex cluster along the rail next to it,
  and the default weld read 2 open edges. At 0.1 the cap reaches 0.466 mm and
  the cluster is gone. `geckoHand` refuses by name any width that cannot fit.
- **Reach is 1 × side, not more.** At 1.25 × side, neighbouring hands on a
  3.29 mm lattice touched each other, and the union came out with handles
  (Euler −6 on `shelf`, −18 on `tall`).
- **A finger that would run into the piece is left off.** The finger's axis
  and rails are cast by the same probe as a branch's. A blocked finger is
  dropped and reported in `hand.dropped` and `fingersDropped`, and the branch
  and its contact stay. Losing a finger changes only the tip's shape.
- `fingerPenetrationMm` measures the fingers against the surface, the way
  `tipPenetrationMm` measures the cap. Worst on `shelf`: 0.2861 mm, against
  the cap's 0.3878 mm.

**Validated, not assumed.** `tree:test` section 7b plans every fixture both
ways, the section-4 wall case included, and compares **exactly**, with no
tolerance: contact points and their order, split, trunk bytes, every branch's
root, tip, heading, length and tilt, refusals, and shaft bytes. The
default's parts must lead the gecko part list in the default's order.
`tree:canonical` runs every gecko solid through `mesh_validate.py` with the
same gates as the default (trunk, `branch0`, `finger0` with volume equal to
hexagon area × length, and the union), then checks that each gecko plan's
contact count, split, trunk and fan are the default's:

| fixture | contacts | branches | fingers kept / left off | union tris (square → gecko) |
|---|---|---|---|---|
| shelf | 16 | 16 | 76 / 4 | 780 → 4776 |
| tall | 28 | 28 | 128 / 12 | 1746 → 8354 |
| tab | 9 | 8 + trunk | 40 / 5 | 310 → 1982 |
| tiny | 1 | 0 (strut) | 5 / 0 | 12 → 158 |

At the default 1e-4 weld, the gecko unions merge more near-coincident
vertices than the square ones (shelf 13 vs 5, tall 34 vs 7). These are the
same boolean-output merges §6 describes, and the same gate covers them:
0 open, 0 degenerate and 0 piercing either way.

**Not claimed:** printability of the fingers themselves. They splay close
to the surface plane, so they lean well past 45°. This style is a
visual/shape option. Whether a hand prints better or worse than a flat cap
is §8.3's contact-geometry question, still unanswered.

---

## 6. The union, and the one thing that needed settling

`unionParts` folds left — the trunk is in every intermediate result, so every
branch is unioned against something it genuinely overlaps. A pairwise tree
would union branch to branch first, and two branches leaving one trunk in
different directions do not touch; `NSO_unionSoups` reports `ok` only when the
part count **fell**, so it would refuse, correctly. The suite asserts every
step merges and that the kernel calls the result **one shell at every step**.

### The weld radius

`tools/mesh_validate.py` identifies vertices inside 1 × 10⁻⁴ mm, which is
`NSO_Repair.WELD_TOL` and four orders below any printable feature — **on a
part**. It is not below every feature of a **boolean's output**: two 1.2 mm
prisms crossing at a shallow angle meet along a curve whose vertices land
microns apart, and `manifoldToSoup` writes them as float32. So the solid
genuinely carries distinct vertices closer together than the default weld
radius, and welding them reports non-manifold edges that are an artefact of
the identification, not of the surface. `docs/CSG_INTEGRATION.md` reached the
same conclusion from the other end — *"the part is watertight; grid-snap
welding was the wrong instrument."*

`tree:canonical` does not pick a looser tolerance and hope. It **measures** the
closest distinct pair of vertices in each solid, derives the weld from that by
`NSO_weldEpsFor`'s own rule — `min(what you wanted, a third of the shortest
thing there is)` — so the tolerance is a consequence of the geometry rather
than a dial, and validates there. It then runs the **default** weld as well and
asserts the difference is only ever of that one kind.

| case | parts | union tris | closest vertex pair | default weld |
|---|---|---|---|---|
| shelf | 17 | 780 | 3.34 × 10⁻⁶ mm | merges 5 of 392 vertices → 9 non-manifold edges, Euler 7 |
| tall | 29 | 1,746 | 1.26 × 10⁻⁵ mm | merges 7 of 875 vertices → 12 non-manifold edges, Euler 9 |
| tab | 9 | 310 | 4.35 × 10⁻³ mm | **passes outright**, Euler 2 |
| tiny | 1 | 12 | 1.2 mm | **passes outright**, Euler 2 |

At the derived weld all four come back `PASS`: 0 open, 0 non-manifold, 0 odd,
0 inconsistently-wound, Euler 2, 0 degenerate, 0 self-intersections of either
kind. At the **default** weld, `open_edges`, `degenerate_tris` and both
self-intersection counts are still **0** on all four — so the surface is closed
on both readings and what changes is which vertices are called one vertex.

Every **part** on its own passes at the default weld with nothing excused, and
each carries the cross-section claim as a volume: `signed_volume = side² ×
length`, put to `mesh_validate.py` rather than to our own sectioning code.

---

## 6b. Hollow: the trunk and every branch as a tube

`planTree(host, { hollow: true })` then `hollowTree(plan)` — or
`hollowParts(plan)` alone for the per-part report without the union.
`npm run tree:hollow`, `tree:hollow-tall`, `tree:hollow-tall-gecko`.

**Why.** A real Bambu tree support, cut open, is hollow — the trunk *and* the
smallest branches (confirmed by physical dissection of a real print). And the
solid strut this repo handed to a real Bambu slice came back classified as
Brim / Outer wall rather than Support; a tube is the shape difference that may
change that. `tools/nso_support_slice_artifact.js --hollow [--tree]` writes the
same auto-aimed strut, hollow, for exactly that test.

**The floor is the physics, not a margin.** A nozzle cannot lay a line
meaningfully thinner than itself, and a wall asked for under that is not
printed thin — it is **dropped from the toolpath with no warning** (a 0.5 mm fin
on a 0.4 mm nozzle produced no toolpath at all, and what fixed it was a 0.6 mm
nozzle, not a thickness change). So every wall is `NSO_Thickness.floorFor(nozzle)` —
0.42 mm at 0.4 — through `nso_hollow.js`, and a part that cannot take a tube at
that floor is **left solid**. It is never hollowed thinner and it never refuses
the tree.

### The audit: does `nso_hollow.js` apply to these prisms?

Yes — its definition (erosion by a ball of radius `wall`) is dimension-free and
the trunk and branch prisms are closed solids. Two things did not carry over,
both measured and both fixed in `nso_hollow.js` for every caller:

1. **Its wall gate was blind on a coarse prism.** It probed from the *outer*
   faces' centroids. A prism side is two triangles whose centroids sit a third
   of the way across — outside a 0.36 mm bore — so on a 1.2 mm strut hollowed to
   0.42 mm the gate read **1.2 mm** (the far wall). It now measures from the
   cavity faces too and keeps the thinner reading: **0.420 mm**.
2. **Surface nets is not manifold on a diagonal-only contact.** A smooth erosion
   rarely produces one; a cavity with a keep region cut out of it (below) does:
   17 of 28 tall-fixture branch bores came out with 1–2 non-manifold edges, two
   with open edges, eleven with loose specks. The cavity's node set is now made
   *well-composed* before meshing — only ever by turning a cavity node back into
   material, so walls can only thicken — and specks under 3³ nodes are dropped.

And one thing about the existing refusal: its "wall thicker than half this
piece" test reads the **bounding box**, which on a *tilted* thin part is wider
than the section, so it cannot fire; the field's "leaves no cavity" refusal
catches it instead. The tree asks the same rule of each part's **true section**
(it built them, so it knows it) before calling `hollow()` at all.

### Per part, with a keep region — and why not the obvious two

| approach | shelf fixture, measured |
|---|---|
| one erosion of the whole unioned tree | **334 s**, then refused by `hollow()`'s own gate: 0.032 mm in 7148 places, in the crotches at the collar |
| hollow each part blind, subtract every bore from the union | 2993 faces under the floor, thinnest **0.001 mm**, all at z 3–6: sixteen bores overlapping at the collar leave membranes of whatever their sampling errors happen to leave |
| **each part hollowed with a keep region** | 0 faces under the floor, thinnest **0.420 mm**, 4.4 s |

The keep region (`hollow()`'s new `opts.keep`): every point within a wall — plus
one sample pitch — of **any other part** stays material. So no bore comes within
a wall of another part, and bores are at least two walls apart; and every bore
lies where the union *is* its own part, so the bores go into the unioned solid
the way `hollow()` puts one into a piece: the union's own triangles, untouched,
plus the bore shells. No second boolean. **The cost, stated:** the junction —
the collar and each branch's first stretch until it clears its neighbours — is
a solid knot, where a sliced Bambu tree has one merged bore.

### The fallback

A part stays solid, and is listed in `solid` with its reason and a `kind`:

| kind | when |
|---|---|
| `too-small` | not wider than two floor walls (the section precheck, or `hollow()`'s own "thicker than half" / "leaves no cavity") |
| `fused` | no point of it is both two walls deep and clear of every other part |
| `under-floor` | the wall asked for (`hollowWallMm`), or the wall `hollow()` measured, is under the floor |
| `other` | anything else `hollow()` refuses, in its own words |

Every gecko finger (0.6 mm across) is `too-small` and stays solid. A 0.8 mm
branch added to the shelf tree stays solid, named, while the other 17 parts are
tubes; `hollow()` asked directly agrees. At a **0.6 mm nozzle** the floor is
0.63 mm and a 1.2 mm strut is not wider than two of those, so the whole tree
stays solid — the floor scales with the nozzle, as the physics says it should.

### What is checked

- **Parity, exactly** (tree:test 7b's standard): contacts, trunk bytes, split,
  every branch's root / heading / length / tilt, the refusals, and every part
  byte for byte are the solid plan's; the hollow tree's outer surface **is** the
  solid union, byte for byte.
- **The canonical checker** on every hollow tree at the derived weld: 0 open /
  non-manifold / odd / mis-wound / degenerate, 0 self-intersections, **Euler =
  2 + 2 × bores**, volume = solid − bores, every bore face ≥ 0.42 mm from the
  next surface, and no wall under the floor the solid tree did not already
  have. (The gecko solids already carry finger gaps under 0.42 mm — 1 face on
  shelf, 7 on tall, down to 0.001 mm — measured identically with and without
  the bores. Pre-existing, and not this change's.)

| case | parts hollowed | bores | bore volume |
|---|---|---|---|
| shelf | 17 of 17 | 17 | 13.64 mm³ |
| tall | 29 of 29 | 29 | 35.47 mm³ |
| tab | 9 of 9 | 10 — the trunk carries a contact past its collar, so it has a bore either side | 5.85 mm³ |
| tiny | 1 of 1 | 1 | 1.22 mm³ |

The bore of a 1.2 mm strut at a 0.42 mm wall is **0.36 mm** across — narrower
than the nozzle. The slicer sees it as a real hole (it is far above Bambu's
default 0.049 mm slice-closing radius), which leaves exactly one 0.42 mm line
each side; whether Bambu keeps it is what the slice test will show.

---

## 7. What the reference check compares

`npm run tree:reference`, 21 checks, ~5 s, no browser.

| | this module | the real slice |
|---|---|---|
| contacts on the 69.9 × 69.9 mm footprint | **484** (22 × 22 at 3.29 mm) | **451** — +7.3% |
| trunks the footprint needs | **25** (refused on one) | **36** |
| contacts on one trunk's own 10.65 mm cell | **16** | **12.53** tips per trunk |
| widest branch reach, sideways | **6.50 mm** | **9.17 mm** |
| trunk height, as a fraction of the run | **40.5%** | **21.9%** at its first split |

The last row is the design difference and not an error in either. The
reference splits **50 more times** on the way up — 36 → 451 over 49 layers —
so its first split comes early and each branch carries only as far as the next
split. This module splits **once**, so its trunk runs further before it has to
hand off, and its branches reach less far sideways than the reference's worst
does. Both numbers are printed by the check.

---

## 8. Out of scope, named so the next ticket does not have to re-derive it

1. **More than one trunk.** `planTree` builds one trunk and its fan. It
   computes and reports `trunksNeeded` when one is not enough, and stops
   there: *where* a field of trunks should stand is the layout half of
   `nso_support_aim.js`'s OUT OF SCOPE 3, and placing them well needs a
   Voronoi partition of the contact set this file does not attempt.
2. **Branches that merge, or bend.** Every branch here is one straight segment.
   `NSO_PathSweep` takes N points, so a curved branch is a longer `points`
   array and nothing else — but *which* curve, and around what, is the path
   search that is still nobody's ticket. `docs/HANDOFF.md`'s own note on the
   sweep says not to try to make it grow a Y: union the strands instead.
3. **Contact geometry.** A branch ends in the same flat cap the strut does, so
   it inherits the same `tipPenetrationMm`. `nso_support_aim.js`'s OUT OF
   SCOPE 2 and `nso_seat_surface.js`'s deferred contact layer are still one
   unsolved thing, and this file adds a third caller for it rather than a
   third opinion.
4. **Whether the slicer could bridge it anyway.** `MAX_SPAN_MM` is what the
   reference structure does, not what PLA can do unsupported. A caller that
   has measured its own material passes `maxSpanMm` and this file uses it.

---

## Paint scope: **sub-region** — inherited, not re-decided

Detection is `nso_support_aim.js`'s, so `opts.skipList` is **required** here
for exactly the reasons it is required there, and is passed straight through
without inspection. This file names no faces of its own: every contact it
places sits on a triangle `detectOverhangs` already flagged, so a painted face
is out of the scan before this file ever sees the region. Pinned in the suite.

---

## API

```js
contactPoints(rawTris, region, opts)   // { ok, points, pitchMm, coverageMm, nnMm, ... }
splitPoint(from, apex, contacts, opts) // { ok, point, trunkMm, widestDeg, trunksNeeded }
branch(rootPoint, tip, opts)           // { ok, soup, parts, lengthMm, tiltDeg, tipPenetrationMm, hand? }
planTree(rawTris, opts)                // detect + contacts + trunk + fan
unionParts(parts, opts)                // Promise of the app's own union
hollowParts(plan, opts)                // each part hollowed at the floor, or left solid and why (§6b)
hollowTree(plan, opts)                 // Promise: the solid union plus every bore (§6b)
describe(result)                       // one status line
```

`opts` is everything `detectOverhangs` and `aim` take, plus `maxSpanMm`,
`branchTiltDeg`, `maxContacts`, `regionId`, `stations`, `tipEngageMm` and
`branchStyle` (`'square'` default, or `'gecko-hand'`, see §5), `hollow`
(`true` runs `hollowParts` after planning, §6b) and `hollowWallMm` (default
the floor).
Soups are the app's raw convention: 9 floats per triangle, **Z up**,
millimetres.
