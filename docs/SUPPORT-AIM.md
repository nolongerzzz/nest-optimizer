# Support aim — find the overhang, then point one straight strut at it

`nso_support_aim.js` (`window.NSO_SupportAim`, and a Node module).
Tests: `npm run support:test`, `npm run support:canonical`. Both are in `npm test`.

Two capabilities, wired together but usable apart:

1. **Detect** where a piece genuinely needs support.
2. **Aim** one straight support from the nearest viable base to such a place,
   and grow it until it touches.

Loaded by `index.html` and **not wired to any button**. Same shape as
`NSO_Repair` when it landed: module, suite and docs first, the UI entry point
as its own change.

---

## The audit that came first

The ticket asked for three things to be confirmed reusable before any of this
was written. All three exist, all three are used as they stand, and the last
one changed the design.

### Extend's cross-section-preserving stretch — `NSO_extendRaw`, `app-extend.js`

Does all the growing here. It lengthens along one axis and copies the other two
coordinates through bit for bit, gating that promise coordinate by coordinate
on every run. Nothing in this module reimplements a stretch.

Two constraints in its header drove the design rather than being worked around:

- **It refuses an off-cardinal axis** ("OUT OF SCOPE 5"). So the strut is built
  along its own local **+Z**, grown there with `axis: 'z'` forced, and only then
  turned to face the target. Extend's arithmetic never meets the aim.
- **It refuses a curved axis** ("OUT OF SCOPE 2"). Which is half the reason
  branching supports are a separate ticket: they would need a different growth
  mechanism as well as a different path search.

The order — build, grow, *then* turn — is not stylistic. Turn first and there
is no axis left for Extend to make its promise about; the stretch becomes a
shear through a rounding error and Extend refuses, correctly, for a reason that
has nothing to do with the support.

### The canonical wall-thickness / nozzle-safety floor — `NSO_Thickness.floorFor`

`nso_thickness.js` is the one source, and this module has no second opinion:
no literal, no default, no silent fallback. `floorFor(nozzle)` is `nozzle × 1.05`
— 0.42 mm at a 0.4 nozzle, the figure `tools/mesh_validate.py` and
`nso_skin.js` already use. A strut asked for thinner is raised to it and says
so. A caller with a measured extrusion width passes `minWall` and the floor
steps aside, which is `nso_thickness.js`'s own contract.

**A build with no way to establish a floor refuses.** That is the one place
this module is deliberately unhelpful: a support thinner than one extrusion
line is not a thin support, it is a support the slicer drops, and the print
then fails in the one place it was told not to.

### The contained pose state — `nso_seat_surface.js` and `nso_carve.js`

Both found the same thing from different directions, and it is the finding that
shaped this module most.

The app's pose model is quantised Euler — 90° yaw, 15° tilt/bank, no quaternion
field, and none in `snapshotPlacedPose`. `buildCombinedGeometry` rebuilds each
piece's rotation from those fields and never reads `mesh.quaternion`. So **a
rotation written to the quaternion is visible in the scene and absent from the
export.** Local-Carve keeps the blade out of `state.placed` entirely;
Seat-Against-Curved hands its rotation back as data for `app-seat-surface.js` to
bake into the piece's triangles.

A support aimed along a computed direction is a free orientation by definition —
the direction comes out of the geometry, not out of a menu — so it cannot be
posed either. `place()` **bakes** the turn into the strut's own triangles and
returns the matrix as data. The strut that comes out of `plan()` is already
pointing where it should, and its caller sets no rotation at all. That is also
why what this module returns can go through `tools/mesh_validate.py` as it
stands, which is what `npm run support:canonical` does.

`quatFromTo` and `transformSoup` are reused from `nso_seat_surface.js` rather
than rewritten. `quatFromTo` settles the antiparallel case with a
caller-supplied fallback axis, which a straight-down aim hits every time.

---

## Detection: the angle, and the half that makes it a detector

### The angle test

`n` is the outward unit normal, so a downward-facing surface has `n.z < 0`. The
angle between a plane and the horizontal equals the angle between its normal and
the vertical, so a surface leaning further off the plate than the threshold is:

```
n.z < -cos(angleDeg)            // -0.7071 at the 45° default
```

A flat ceiling is `n.z = -1` (worst); a vertical wall is `n.z = 0` (fine).

**This is not the test the viewport tint uses.** `applyOverhangColors`
(`app-core.js`) flags `n.z < cos(45°)` — every face more than 45° off *up*, a
vertical wall at `n.z = 0` included — then patches the flat underside back out
with a second `n.z > -0.95` clause. It is a tint and has always been a tint.
Reusing it would flag every vertical wall on every piece and miss every flat
ceiling: measured on the cantilever fixture, **20 of 24 faces tinted, 2
genuinely unsupported.** The angle-vs-normal shape is borrowed; the threshold is
corrected, and the correction is why this is not a one-line call into it.

### The half that matters

A steep downward face with material under it is already supported. So every
flagged triangle gets one ray straight down from its own centroid, and a hit
before the plate drops it.

That test is the whole difference between "faces that point down" and "regions
that need support". The suite pins it on a pair of shapes a tint cannot tell
apart: a cantilever arm, and the same arm with a pillar under half of it. Same
faces, same normals, same angle, and the unsupported area goes 200 mm² → 100 mm².

The ray's window runs **all the way to the plate**, not to just short of it. The
case that settles it is the normal one: a pillar standing flush under the
overhang, its top face coincident with the face being tested. The ray then
starts inside that pillar and its only hit is the pillar's own underside, on the
plate — so a window stopping a hair above the plate reports a clear line through
solid material and calls a fully propped overhang unsupported.

### Two floors, both measured across the repo's fixtures

- `minDropMm`, default **0.5 mm**. A face closer than this to the plate has
  nowhere to put a support — the strut would be shorter than it is wide. Below
  it sit `pin.stl`'s bottom chamfer (0.00 mm), `fixture_sphere_curved.stl`'s
  contact patch (0.01), `out-box-round-r05.stl`'s bottom fillet (0.03) and the
  hinge knuckles' bores (0.05). All of them were being reported as overhangs
  before this floor existed, and none of them is one.
- `minAreaMm2`, default **1.0**. Below it a flagged patch is a tessellation
  artefact — one sliver on a curved flank that tipped past the threshold — not a
  region worth a strut.

### The vertical-ray grid

One ray per flagged face against every triangle is O(n²). A vertical ray can
only meet a triangle whose XY footprint contains it, so bucketing every triangle
by that footprint once turns the scan into flagged × (the handful in one cell).
On `tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 32862 triangles: casting one
ray from every triangle takes **169 s** brute force and **0.27 s** through the
grid, and the whole `detectOverhangs` scan of that part lands at **0.13 s**
(median of five runs).

The suite pins grid against brute force **ray for ray** on four real fixtures
rather than trusting the index, because one that is merely nearly right reads
exactly like a correct one until the day it does not. It already caught one: the
query index was floored without the clamp the bucketing applies, so every ray
arriving on the mesh's own +x or +y boundary looked in cell `side`, which does
not exist, and reported a clear line through solid material. On `hinge_pip.stl`
that was 81 rays out of 1528 — on a symmetric part, a whole face's worth. Over
all 32862 rays of the tape fixture the two now agree exactly.

Arbitrary-direction rays are left brute force on purpose: base viability casts
one ray per candidate, so a second index would cost more to build than the scan
it saved.

### Paint scope: **sub-region**

Per the standing rule in `docs/HANDOFF.md`. This feature acts on an identifiable
sub-region — it names specific faces as needing support, and a support lands on
those faces and nowhere else — so the check is scoped to the faces it flags, and
paint elsewhere on the piece does not stand it down.

`opts.skipList` is a **required** input, not an optional one with an unpainted
default, because unpainted is the value a caller gets by forgetting. Pass
`nsoMaskFaceList(m)` straight through; the raw `axisIdx` / `keepMin` / `d` each
click recorded are read as recorded and never re-derived from a bounding box.

| `skipList` | behaviour |
|---|---|
| omitted | **refused** by name — no unpainted default |
| `null` (a painted face with no axis to name) | **refused** — the caller's cue that the paint cannot be honoured |
| `[]` | states that nothing is painted; the scan runs |
| entries | those faces are skipped; everything else is scanned |

---

## The aim: one straight line, from the nearest viable base

A base is **viable** when the segment from its foot to the target is clear.
That is the condition that makes this a single direction rather than a path
search. A base whose line is blocked is not nudged, not routed around and not
bent — it is rejected, the next-nearest is tried, and when none is clear the aim
refuses and names what blocked it and how far short it fell.

**"Nearest" means the nearest point on the base, not the point below the
target.** On the plate those coincide. On another piece they do not, and taking
the straight-down point there aims a support at thin air beside the piece it
meant to stand on. Pinned in the suite: a prop spanning x 22–26 under a target
at `[20, 5, 16]` is reached at its nearest edge, `hypot(2, 0, 6) = 6.325 mm`,
and beats the plate's 16 mm.

Both ends of the segment are excluded from the blockage test by one epsilon: the
foot sits *on* the base and the tip sits *on* the target, so a hit at either end
is the thing the support is attaching to.

### The flat cap on a tilted aim — measured, not hidden

The tip point lands on the target exactly. But the cap is a flat square
*perpendicular to the aim*, and the face it meets is not, so whenever the aim is
oblique half the cap sits proud of the surface and the other half stops short.
The extreme is the cap corner, at

```
(side / 2) × sin(angle between the aim and the target's normal)
```

— **0.189737 mm** for a 1.2 mm strut at 18.435°, pinned in the suite against
that closed form rather than against a tolerance.

That is a property of a flat cap, not an error in the aim, and it is exactly the
contact-geometry layer `nso_seat_surface.js` deferred for the same reason. It is
reported as `tipPenetrationMm` rather than left for a caller to discover,
because a support penetrating its target by a fifth of a millimetre is fine and
one penetrating it by two is a support driven through the piece, and nothing
downstream can tell those apart without a number.

---

## What the canonical checker says

`npm run support:canonical` puts every support through `tools/mesh_validate.py`.
All three cases — a vertical aim, an oblique aim off a second piece, and the
real 32862-triangle tape part — come back `PASS` with 0 open, non-manifold, odd
and inconsistently-wound edges, Euler characteristic 2, 0 degenerate triangles
and 0 self-intersections of either kind, at 12 triangles and 8 welded vertices:
the stretch re-tessellated nothing.

The cross-section claim is put to that independent implementation as a volume:

| case | signed volume | side² × length |
|---|---|---|
| cantilever (vertical) | 23.040011 | 1.2² × 16 = 23.040000 |
| oblique, 18.4° off vertical | 9.107360 | 1.2² × 6.324555 = 9.107360 |
| tape, real part | 25.979227 | 1.2² × 18.041130 = 25.979227 |

A solid whose volume is exactly the cross-section times the length has that
cross-section the whole way. `uniformity()` asks the same question a second way,
sectioning the finished, turned solid perpendicular to the direction it was
actually aimed along: area spread across 15 stations is 0 % on the vertical aim,
**2.3 × 10⁻⁵ %** on the oblique one and 4.6 × 10⁻¹⁴ % on the tape.

And the piece itself comes out of the scan byte-identical — pinned on the raw
buffer in the suite, and field for field against the fixture on disk in the
canonical check.

### What is deliberately *not* asserted

The support and the piece **as one mesh**. They are two solids in contact, not
one solid, and the checker says so: run together they report 14 piercing and 5
coplanar pairs on the cantilever case, every one of them at the contact. That is
the checker being right. Join's A and B are in the same state before a boolean,
and `nso_planar_fuse.js`'s header makes the same point about faces that "touch
by construction". Gating the pair would be gating that two things touch, which
is the whole objective.

---

## Out of scope, named so the next ticket does not have to re-derive it

1. **Curving / branching organic paths.** Multi-segment, spline-routed tree
   supports of the kind Bambu Studio grows — a trunk that splits, branches that
   merge, a path that bends around the piece instead of stopping at it. This
   module computes one straight direction from one base to one point and refuses
   when that line is blocked. It does not route around the obstruction, and it
   must not be extended to: a curved support cannot be grown by Extend at all,
   so branching needs a different growth mechanism as well as a different path
   search. Both belong in the next ticket, **together** — that pairing is the
   finding, not the restriction.

   **The rest of it landed later.** `nso_support_tree.js`
   (`NSO_SupportTree`, `docs/SUPPORT-TREE.md`) is the path search and the
   attachment: it derives the contact points an overhang needs from the
   overhang's own geometry, computes where the trunk has to stop, calls
   `aim()` for the trunk and `NSO_PathSweep` for every branch, and unions the
   lot with `NSO_unionSoups`. It builds **one** trunk and its fan; a field of
   trunks is still item 3 below. It does not route around a blockage either —
   a branch whose line is blocked is still refused, by rail as well as by
   axis.

   **Half of that landed in the same merge.** `nso_path_sweep.js`
   (`NSO_PathSweep`, `docs/CURVING-PATH.md`) is a mitred polyline sweep built
   on Extend's correctness argument carried round a corner, and it is the
   growth mechanism a branching support needs. So the next ticket does not have
   to invent one — it needs the **path search** (where to route, and around
   what) and the attachment, and it should call `NSO_PathSweep` rather than
   grow anything itself. Both modules are parked unwired, which is the right
   order: the primitive first, the routing that drives it second. `NSO_Carve.probeTarget()`
   is the oriented frame to start a branch's first station from, per that
   module's own audit.
2. **Support interface / contact geometry.** The strut ends in its own flat cap.
   A breakaway tip, a contact layer, a tapered head that widens into the
   overhang: none of them are here, and the `tipPenetrationMm` number above is
   the measurement of what their absence costs. `nso_seat_surface.js` deferred
   the same layer; the two should be solved once, for both.
3. **Support density / layout.** One region gets one strut, aimed at one point.
   How many struts a large overhang wants, and where they sit relative to each
   other, is a layout question this file does not ask.

   **How many is now answered**, by `nso_support_tree.js`: a square lattice at
   a span measured off a real Bambu tree support, topped up until the region
   is covered, with the achieved covering radius reported. **Where a field of
   trunks should stand relative to each other is still open** — that module
   builds one trunk, and when one is not enough it refuses and names how many
   the region would take.
4. **Bridging.** A ceiling spanning two walls is flagged whenever nothing sits
   under it, because nothing sits under it. Whether the slicer could bridge it
   unsupported is a span-and-material judgement no angle test can make. Callers
   wanting it gate on `region.spanMm` themselves; detection reports the span and
   takes no view.

   `nso_support_tree.js` is that caller, and the view it takes is a **contact
   pitch** rather than a droop model — because the reference does not contain
   a droop model either. Bambu never lets anything span air: the 67 mm
   `Bridge` moves in `fixtures/3mf/tabletop.gcode.3mf` are all bridging over
   the support interface directly beneath them. See docs/SUPPORT-TREE.md §1.

---

## API

```js
detectOverhangs(rawTris, opts)      // { ok, regions: [...], tris* counts, reason }
nearestBase(point, bases, opts)     // { ok, base, from, dir, length, considered }
buildStrut(opts)                    // { ok, soup, sideMm, floorMm, flooredUp }
grow(soup, targetLengthMm, opts)    // NSO_extendRaw's own result, verbatim
place(soup, from, dir, opts)        // { ok, soup, matrix, quat, turnedDeg }
aim(point, bases, opts)             // base -> build -> grow -> place
plan(rawTris, opts)                 // detect + aim, for the biggest region
sectionAt(soup, origin, dir, t)     // { ok, area, perimeter, segments }
uniformity(soup, origin, dir, opts) // { ok, stations, areaRelSpread, ... }
describe(result)                    // one status line
```

`bases` is `[{ kind: 'plate', z }, { kind: 'piece', soup, id }]`. Soups are the
app's raw convention: 9 floats per triangle, **Z up**, millimetres.

`grow()` returns Extend's result unwrapped — its reason, its gates, its measured
residual — because a support that failed to reach must say so in the same words
a stretch that failed to reach says it, and wrapping the failure in a new
sentence is how two vocabularies for one event start.
