# Local carving tool — Task 1 audit

A small, freely-oriented, local carving tool: pick a blade/bit profile, place it
at any edge, corner or face, at any orientation, subtract just that local
volume. A handheld rotary tool, not a table saw.

This document is the audit that was asked for **before** any of it is designed.
Every number below came out of `tools/nso_carve_audit.js`, which drives the real
app in real Chromium against the real manifold kernel and puts every result mesh
through the canonical checker, `tools/mesh_validate.py --gate`:

```
node tools/nso_carve_audit.js      # exit 0 = every finding here still holds
npm run carve:audit
```

Nothing here is asserted from reading source. Where the audit contradicts the
ticket's starting premises, it says so.

---

## 0. Two corrections to the starting premises

**a) There is no one feature called "Seat + Subtract".** The live Join card
(`index.html:86-108`, wired in `setupUI`, `app-join.js:2742`) has **Seat
flush**, **Seat (support)** and **Subtract B from A** as three separate buttons
the user presses in sequence. Seat only moves piece B; Subtract only cuts. They
share one thing — `NSO_plugFrame` — and that shared frame is the whole of the
coupling. The full-plane slice the ticket calls "Square Cut" is the **Cutter**'s
**Split** (`index.html:64-84`; `cutActiveModel`, `app-join.js:2422`, over the
soup maths in `app-cut.js`), whose plain rectangular-section case the source
calls "Square-split". It has no bit and no boolean: it splits a soup on an axis
plane, at a yaw the user sets in 15° and 90° steps.

So the mechanism to reuse is real, and it is `NSO_plugFrame` + `NSO_CSG` +
`subtractSoupBFromA`. It is just not one feature with that name.

**b) There is no bit *profile* catalog.** `app-library.js` has a `CATALOG`, and
it is a flat array of **STL filenames** served out of `library/` —
`USB_bit.stl`, `sd_bit.stl`, `box_bit_12x8x8.stl` and so on. A row click fetches
the file and hands it to `handleFiles`, the same path a file drop takes. Those
"bits" are fixed-size connector solids for punching a port, authored offline.
There is no parametric profile, no size field, no family of shapes, and nothing
generates geometry.

The pattern the blade library should follow is **not** that catalog. It is
`NSO_Skin.PATTERNS` (`nso_skin.js:202`): `{ name: { defaults, describe } }`, a
named registry of parametric profiles with per-profile defaults and a
human-readable describe, driven from a `<select>` in the viewport
(`index.html:192`, `crosshatch` / `zigzag` / `ring`). That is a profile family
with interchangeable shapes, already shipped, already tested. Section 4 below
takes it as the model for Task 2.

---

## 1. What the shipped pipeline actually is

Three pieces, in order.

**`NSO_plugFrame(bitMesh, hullCenterWorld, aWorld)` — `app-join.js:496`.** Takes
the bit's **local AABB** and its world matrix and picks **one** of the box's six
face directions as the punch axis. The choice is a local probe, not a centroid
vector: for each of the six candidates it steps a margin out from the bit's
centre and a margin in, and scores 2 when stepping out clears hull A *and*
stepping in stays inside it, 1 when only the first holds, -1 otherwise, with the
outward direction as a 0.01 tie-break. That local test is why it holds on a
stepped or non-convex hull. It returns `{ matrix, inv, box, axis, sign,
outerNormal, punch, capCoord, span }`.

Note what the frame *is*: it is free-oriented in world space — `outerNormal` is
a box axis pushed through the bit's own world matrix, so a rotated bit gives a
rotated frame with no special casing. What it is **not** is free of the box:
there are exactly six candidates, all of them whole faces of one AABB. There is
no notion of an edge of the bit, or of two hull faces at once.

**`NSO_CSG` — `app-join.js:1004`.** The manifold-3d adapter. `soupToManifold`
turns a world-space triangle soup into a `Manifold`, and the `mesh.merge()` call
is what lets the kernel see a soup with no shared indices as a solid.
`manifoldToSoup` comes back. The kernel is `manifold-3d@3.5.3`, loaded from a
CDN with a copy vendored at `vendor/manifold/manifold.js` for the offline
checks. `buildCutVolume` builds the **safety box**: a real `Manifold.cube`
spanning from just outside the bit's own tip, inward along `frame.punch`,
stopping `minWall` short of wherever hull A's surface is actually found — five
probe rays across the bit's footprint (centre plus four inset corners), worst
case wins. It is deliberately not derived from any bounding box; only a real hit
test against `aWorld` can say how thick a wall is.

**`subtractSoupBFromA(aWorld, bWorld, { plugFrame, minWall })` —
`app-join.js:1359`.** Welds both soups (`NSO_weldEpsFor`), lifts both to
Manifolds, builds the safety box, **clips the bit to it** (`manB.intersect(
safetyBox)`), then `manA.subtract(bClipped)`. Guards: kernel status on every
object, empty result, and a no-op volume guard that refuses a "successful"
boolean which removed less than `max(1e-3, 0.01% of hull volume)` — because the
caller deletes B on success, and a silent no-op would lose the bit for nothing.
Any failure returns `{ ok: false, soup: aWorld }` and the caller leaves A
untouched. It requires `opts.plugFrame`; with no frame it refuses outright.

**`NSO_seatFlushBitToHull(hullMesh, bitMesh, opts)` — `app-join.js:691`.** The
placement step, and the one that matters here. Up to three iterations of: take
the frame, take the **four corners of the bit's outer box face**, cast a ray
from each along `frame.punch`, fit a plane to the four hits (Newell), rotate the
bit's outer normal onto that plane normal (clamped to 20°), then translate along
the fitted normal until the reference face sits `proud`/`gap` off the hits. It
writes `bitMesh.quaternion` and `bitMesh.position` directly.

---

## 2. The gap, measured

> **Can a bit currently be placed at a corner or an edge — two intersecting
> faces — or only flush against a single flat face like Seat does today?**

**Only flush against a single flat face. The refusal is explicit, and it is in
Seat, not in the boolean.** Hull `fixtures/box_hull_80x40x20-2.stl` (80 × 40,
20 tall on the plate), bit `library/box_bit_12x8x8.stl`, bit bottom 3 mm below
the hull's top:

| placement | outer-face rays that hit | Seat flush | Subtract, same pose | canonical checker |
|---|---|---|---|---|
| wholly over the top face | 4/4 | **ok**, skin error 0.0000 | ok, 288.000 of 288.000 mm³ | PASS |
| straddling the top +X edge | **2/4** | **REFUSED** — `corner 1 missed hull along punch axis` | ok, 144.000 of 144.000 mm³ | PASS |
| over the +X/+Z top corner | **1/4** | **REFUSED** — `corner 1 missed hull along punch axis` | ok, 72.000 of 72.000 mm³ | PASS |

The gate is `app-join.js:783-791`: all four corner rays must land, or the bit's
pose is restored and the seat returns `corner N missed hull along punch axis`. A
bit that straddles an edge has two of its four outer corners hanging over
nothing; a corner bit has three. That single precondition is the entire
capability gap the ticket is about.

**And this is the finding that reshapes Task 3: the CSG pipeline already does
corners and edges correctly.** Parked by hand at an edge or a corner and handed
straight to `subtractSoupBFromA`, the boolean removes **exactly** bit ∩ hull —
144.000 of 144.000 mm³ at the edge, 72.000 of 72.000 mm³ at the corner, zero
shortfall to 1e-3 — and the result gates clean on the canonical checker:
0 open edges, 0 non-manifold, 0 odd edges, 0 inconsistent winding, 0 degenerate,
0 slivers at aspect 100, 0 piercing self-intersections, Euler characteristic 2,
verdict PASS. Task 4's "no leftover slivers, no non-manifold edges at the carve
boundary" is **already true** of the shipped kernel path at a corner. What is
missing is a way to get the bit there.

### 2b. Where Seat does not refuse, it silently undoes the intent

Worse than the refusal, and the reason a carving tool cannot simply call Seat
with a looser gate. Park the same bit centred on the hull's **vertical** +X
edge, mid-height: now all four outer-face corners are on the bit's +X face,
which is entirely outside the hull, and all four rays land on the +X wall. 4/4.
Seat reports success.

What it did: the bit went from **6.000 mm of overhang past the wall** to
**0.0100 mm** — its x span moved from 34…46 to 28.010…40.010. Seat did not carve
the edge. It drove the straddle out and buried the bit as a plug through the one
flat face it picked, and said `Seated`. No refusal, no warning.

That is not a bug. It is Seat's entire purpose: *make this placement flush
against one face.* A free-orientation tool therefore cannot route its placement
through `NSO_seatFlushBitToHull` at all — not with a relaxed corner-ray gate,
not with a larger tilt clamp. It needs its own placement step. The parts to
reuse are below it: `NSO_plugFrame`, `NSO_CSG`, `subtractSoupBFromA`.

> **Since measured, this straddle is refused** (`NSO_seatStraddle`, `app-join.js`;
> `npm run seat:overhang`). The measurement above is what the shipped build did
> when this audit ran, and it was taken up as a defect in its own right: the
> silent 6 mm → 0.01 mm collapse is destructive, and the same placement one
> corner further out already refused with `corner N missed hull along punch
> axis`. Seat now refuses this pose too — *bit straddles that hull face -
> 6.00mm of it stands proud and the rest is already inside* — and moves
> nothing. Nothing below changes: a carve still needs its own placement step,
> and now Seat will not even appear to offer one.

---

## 3. Four more constraints Task 3 has to design around

**a) The app's pose model cannot represent a free orientation.** A placed
piece's pose is Euler, in fixed order, with quantised components:
`applyMeshRotation` (`app-core.js:2616`) composes `rotation.set(tipX·90° +
tiltX + flipX·180°, rotY, tipZ·90° + tiltZ)` where `rotY` steps 90°
(`rotateSelected`, `app-core.js:2521`) and `tiltX`/`tiltZ` step **15°**
(`tiltSelected` 2602, `bankSelected` 2588). There is no arbitrary-quaternion pose field, and
`snapshotPlacedPose` (`app-core.js:2502`) saves only those Euler components — not
`mesh.quaternion`.

Seat already lives with this by writing the mesh quaternion directly and
syncing back only `x`, `z` and `liftY`. That quaternion survives a drag
(`applyPlacedXZ` → `settlePlacedOnBed` touches only `position.y`) but is
**destroyed by any pose button**, because each one calls `applyMeshRotation`,
which rebuilds the rotation from the Euler fields. A 15° grid is not "any
orientation", so Task 3 needs either a real quaternion pose field carried
through `applyMeshRotation`/`snapshotPlacedPose`, or its own placement state
that does not pretend to be a placed-piece pose. This is the largest
architectural decision in the ticket and it is in `app-core.js`, not in the
CSG layer.

**b) Subtract consumes the bit.** `subtractBFromA` (`app-join.js:1453`) deletes
model B from `state.models`, removes its mesh from the scene and drops it from
`state.placed`. That is right for a one-shot port plug. It is wrong for a
carving tool, where the whole point is to place the same blade again at the next
edge. A carve needs the bit kept, or regenerated per stroke.

**c) `minWall` guards one axis only.** `buildCutVolume` measures depth by
ray-casting along `frame.punch` alone, so on a hollow hull the "far wall" it
stops short of is the **opposite outer wall**, tens of mm away. Measured on
`fixtures/box_open.stl` (60 × 40 × 25, 2 mm walls): a corner bite meets only the
2 mm wall — bit ∩ hull is 48.000 mm³ — and with `minWall: 1.0` the **whole**
48.000 mm³ is taken. The near wall is severed clean through into the cavity.

The result still gates clean (`--min-wall 1.0`: 0 open, 0 non-manifold, 0
winding, 0 piercing, Euler 2, PASS) — the geometry is sound, the wall is simply
gone. So this is a *behaviour* gap, not a topology one, and the honest framing
is: a corner carve is exactly the case where one punch axis stops describing the
material at risk, because two faces are in play. Any generalisation of the
safety box is the same problem as the placement frame, one level down.

**d) A precedent worth following.** `nso_inside_corners.js` already solves "give
a concave feature a convex treatment" by running the **unmodified** convex
engine on the *plug* — the box that was cut out — and letting the boolean mirror
it inward. Its header says why a concave version of the maths would be wrong.
The same shape of answer applies here: keep the kernel path untouched, build the
blade as a solid, place the solid, let `subtract` do the rest.

---

## 4. What this means for Tasks 2 and 3

**Task 2 (blade library)** is low-risk and mostly additive. Follow
`NSO_Skin.PATTERNS`, not `app-library.js`'s STL catalog: a named registry of
parametric blade profiles, each with `defaults` and `describe`, each emitting a
closed watertight solid soup in blade-local coordinates — flat shave (a slab),
ball-nose gouge (a capsule/hemisphere-ended cylinder), V-groove (a wedge). The
existing `Soften` profiles already use exactly these names for the same shapes
(`app-finish.js:29`: `profile: 'round' | 'chamfer'`), so the vocabulary is
established.

**Task 3 (free-orientation placement)** is where the ticket's difficulty
actually lives, and the audit moves it: it is **not** CSG work and **not** a
loosened Seat. It is (i) a placement frame that can be aimed at an edge or a
corner rather than picked from six box faces, and (ii) a pose representation the
app does not currently have (3a). Both are outside the boolean. The boolean is
already correct — §2 proves it at 0.000 mm³ shortfall and a clean gate on a
corner gouge, an edge chamfer and a flat shave, which is Task 4's whole
acceptance list, passing today, on hand-parked poses.

**Task 4 (validation)** can therefore reuse this file's harness verbatim:
`tools/nso_carve_audit.js` already writes each result to STL and gates it on
`tools/mesh_validate.py`, with the three canonical cases in place.

---
---

# The build — Tasks 2 and 3

Everything below is measured by `tools/nso_carve_test.js`, which runs
`nso_carve.js` under node and then drives the shipped tool in real Chromium
against the real manifold kernel, putting every result mesh through the
canonical checker:

```
node tools/nso_carve_test.js       # exit 0 = every gate below still holds
npm run carve:test
```

Files: `nso_carve.js` (geometry core, THREE-free, node-tested), `app-carve.js`
(app layer), a Carve block in `index.html`'s Finish menu, and three surgical
edits to `app-core.js` plus one to `app-join.js`, each described below.

## 5. What shipped, and the shape of it

**`nso_carve.js` — the geometry.** The blade registry, the target probe, the
placement, and the status-line wording. No THREE and no DOM, so the whole file
runs under node; the app layer is the only part that needs a browser. This
follows `nso_skin.js` exactly, including its dual `module.exports` / `window`
export.

**`app-carve.js` — the app.** Three things only a browser can do: arm a click,
lift the core's plain-data frame into the THREE types
`NSO_CSG.buildCutVolume` reads, and commit the result. **`app-join.js`'s boolean
is untouched** — `subtractSoupBFromA` runs exactly as it does for Subtract, on a
frame built elsewhere. Same pattern as `nso_inside_corners.js`, which gives a
concave pocket a convex treatment by running the unmodified convex engine on the
plug: keep the kernel path, change what you feed it.

### The blade-local convention

One convention carries the whole design, and it is why the free orientation
costs nothing downstream:

| axis | meaning |
|---|---|
| **+Y** | out of the material. The blade's local AABB is `y ∈ [0, height]`; `y = 0` is the cutting tip, `y = height` the shank end, which stays outside the piece. |
| **+Z** | the blade's sweep axis — the length of a slab, the apex line of a V-groove. Placement lays it along an edge. |
| **+X** | the cross axis, `Y × Z`. |

Because local `+Y` is always the outward normal, the frame handed to the kernel
is always `{ axis: 1, sign: 1, capCoord: height }`. Every orientation lives in
the matrix alone, and `buildCutVolume`'s own arithmetic never learns that
anything changed. Pinned: `tools/nso_carve_test.js` §1d asserts it over 24
aim/roll combinations.

## 6. Task 2 — the blade library

`NSO_Carve.BLADES`, shaped as `{ name: { defaults, describe, build, reach } }`.
That is `NSO_Skin.PATTERNS`'s shape, deliberately — the same per-profile
defaults, the same human-readable `describe`, the same `withDefaults` merge that
drops any key the profile does not declare, driven from a `<select>` in the
viewport the same way the skin patterns are. It is **not** `app-library.js`'s
`CATALOG`, which is a flat list of STL filenames for fixed-size connector plugs
authored offline; a blade has to be sized to the cut, so it is built, not
fetched.

| blade | parameters | what it leaves |
|---|---|---|
| `flat` | `width`, `length` | a flat-bottomed local shave with square walls |
| `ball` | `radius` | a rounded gouge with no stress corner in it |
| `vee` | `angle`, `length` | a V-groove or a chamfer — **cut deeper for a wider one** |

Two builders serve all three: `extrudeZ` (a convex polygon in local XY pushed
along local Z — the slab and the wedge are both prisms) and `revolveY` (a
surface of revolution from a ring list, with a radius-0 ring handled as a pole
so the fan does not emit zero-area triangles). Each returns a closed watertight
solid, wound outward, positive volume.

`vee` takes no `width` on purpose. Its half-width is `height · tan(angle/2)`, so
cutting to depth `d` leaves a groove `2·d·tan(angle/2)` wide: **depth is the
size control**, and one blade gives every chamfer size.

`height` is not a UI field either. `app-carve.js` derives it as
`depth + 2 mm` (and at least `radius + 2` for a ball), so "depth deeper than the
blade" — a real refusal the core still enforces and the tests still cover —
cannot be reached from the controls at all.

**Gated** (`§1a`): every blade, at two sizes each, is one closed solid — 0 open,
0 non-manifold, 0 odd, 0 winding, 0 degenerate, 0 sliver, 0 piercing, Euler 2 —
with the analytic volume to 1e-3 for the two prisms (`360.000`, `18.000`,
`360.000`, `22.368` mm³) and just under the ideal capsule for the ball, as an
inscribed faceted hemisphere must be: 1.559% under at 24 segments, 0.180% at 64.

## 7. Task 3 — free-orientation placement

This is the part the audit said would be hardest, and the audit was right about
where the difficulty is: not in the boolean, and not in a looser Seat.

### The probe: one formula for face, edge and corner

`NSO_Carve.probeTarget(hullSoup, point, radius)` gathers the triangles a blade
aimed at `point` can actually reach, clusters their normals, and lets the number
of clusters say what the feature is. **The outward direction is the normalised
sum of the distinct face normals** — the bisector. For one face that is the face
normal; for two it is the direction a file would take down an edge; for three it
is the corner diagonal. One formula, three features, and a face is the
one-cluster case of it rather than a separate path.

`radius` defaults to the blade's own `reach`, which makes the question
self-scaling and physically honest: *which faces will this blade touch?* A 1 mm
ball 1.5 mm in from an edge reads a face; a 2 mm ball at the same point reads the
edge, because it will meet both.

Two thresholds, because they answer different questions:

- **`COS_SAME` (~5°)** groups triangles into *planes* — two triangles of one
  flat face differ by float noise only.
- **`DIHEDRAL_DEG` (20°)** then groups planes into *features*: is this a real
  edge, or one smooth surface that happens to be tessellated? Transitive,
  area-weighted.

The second threshold is not decoration, it is a bug fix, and §9c records the
measurement that forced it.

The reference point snaps onto the feature: at a real edge or corner it is the
**intersection of the planes in play**, so a click 0.5 mm off an edge still
places the blade on the edge. That meet is bounded — see §9c.

### The placement

`NSO_Carve.placeBlade` builds the world matrix as columns `[X, Y, Z, origin]`:
`Y` is the outward bisector, `Z` the sweep axis rolled by `roll` about `Y`,
`X = Y × Z`, and `Z` is then re-derived as `X × Y` so the basis is exactly
orthonormal. The origin is the blade's tip, `depth` mm inside the surface along
`−Y`. It is a pure rotation plus a translation, so local mm are world mm — which
matters, because `buildCutVolume` divides its measured world depth by the basis
length to get back to local units and a scale here would quietly resize the
safety box.

**Gated** (`§1d`): over 6 aim points × 4 roll angles, every basis is orthogonal
to 5.6e-17, unit to 2.2e-16, right-handed, the tip lands exactly `depth` inside,
and the frame is always `{axis 1, sign 1, capCoord height}`. Roll leaves outward
untouched to 1e-12 and turns the sweep axis a right angle to 6.1e-17.

### Why it does not go through Seat

It cannot, and this is worth stating because "relax Seat's corner-ray gate"
looks like the cheap answer. §2b measured what Seat did to a straddle it did
*not* refuse: it drove 6.000 mm of overhang down to 0.0100 mm and buried the
bit as a plug through the one flat face it picked, reporting `Seated`. Making
something flush against one face is Seat's purpose, not a limitation of its
tolerances — and that pose is now refused outright rather than converted, so
Seat answers a straddle with a refusal either way. A carve therefore needs its
own placement step over the shared kernel path, which is what this is.

### Pose state: contained, by decision

A blade is **never a placed piece**. It is built, transformed, subtracted and
dropped, so it never enters `state.models` or `state.placed`. Two things follow,
both of which the audit listed as problems:

- **The bit is not consumed.** `subtractBFromA` deletes model B on success —
  right for a one-shot port plug, wrong for a tool you place at the next edge.
  Gated (`§2g`): three carves off one armed tool, `state.models` and
  `state.placed` unchanged, each cut landing, the piece still gating clean after
  six.
- **It never meets `applyMeshRotation`**, which rebuilds a piece's rotation from
  quantised Euler fields and would destroy a free orientation the moment any
  pose button was pressed.

## 8. Task 4 — the gates

Every case below is the shipped tool driven through `nsoCarveAtPoint`, with the
result mesh read back off the plate and put through
`tools/mesh_validate.py --gate`. "Gates clean" means the **canonical** verdict
plus 0 open / 0 non-manifold / 0 odd / 0 inconsistent winding / 0 degenerate /
0 piercing / Euler 2.

| case | feature read | removed vs blade ∩ piece | gate |
|---|---|---|---|
| corner gouge, ball r2, depth 1.5 | `corner`, 3 faces | 1.9086 of 1.9086 mm³ | PASS, 166 tris |
| edge chamfer, vee 90°, depth 1 | `edge`, 2 faces | 6.0000 of 6.0000 mm³ | PASS, 182 tris |
| flat shave, slab 8×12, depth 1.2 | `face`, 1 face | 115.2001 of 115.2001 mm³ | PASS, 198 tris |
| six carves on one piece | — | each exact | PASS, 756 tris |
| dome gouge, ball r1.5 (curved) | `face`, 16 planes merged | 3.1820 of 3.1820 mm³ | PASS, 2588 tris |
| dome V-groove on the flank | `face`, 1 feature | 1.4031 of 1.4031 mm³ | PASS, 2634 tris |
| near-through cut, depth 19.5 on 20 mm | `face` | 304.000 of 312.000 — **8 mm³ held back** | PASS, 772 tris |
| 2 mm tray floor, small ball | `face` | 0.3302 of 0.3302 mm³ | PASS, 358 tris |

The flat shave's removal is exactly `width × length × depth`
(`115.2001` vs `115.2000`), which is the one case with a closed form to check
against. Undo returns the piece **vertex for vertex** (worst delta `0`) and says
`Undo: Carve reverted`.

### Slivers: introduced, measured, not gated

The ticket asked for "no leftover slivers", and the honest answer is that a
carve **does** leave high-aspect triangles, so here are the numbers rather than
a claim:

| case | over aspect 100 | worst aspect | smallest triangle area |
|---|---|---|---|
| box carves | 24–29 of 166–198 | 10,643 | 3.10e-05 mm² |
| after six carves | 88 of 756 | 53,312 | 3.10e-05 mm² |
| dome carves | 91–93 of ~2,600 | 17,864 | 6.29e-07 mm² |
| tray gouge | 24 of 358 | 1,354 | 3.15e-03 mm² |

The input fixtures have **0** slivers (worst aspect 8.4 to 14.6), so these come
from the carve: manifold retriangulates a curved cut boundary against a
tessellated surface, and thin triangles are what that produces. **None has
collapsed** — every one has real area, which is asserted on every case, and
`tools/mesh_validate.py`'s own `verdict()` reports slivers and deliberately does
not fail on them, because a thin triangle with area is watertight and prints.
The four that *were* topologically harmful are gone; §9b is that story.

Cleaning up the survivors is real work and it is not this ticket — see §10.

### minWall: still one axis, and it says so

Left as-is by decision. The safety box measures depth along `frame.punch` only,
so where the carve engages more than one face the status line names it, on every
such carve rather than only when it goes wrong:

```
Carved corner - ball-nose gouge, r 2 mm, 4 mm tall, 24 segments, depth 1.5 mm
  - 1.909 mm³ removed - wall checked along the cut axis only, 3 faces in play
  - open edges 0→0, non-manifold 0→0, welded away 4 seam slivers
```

A one-face carve does **not** claim the caveat (gated). And where minWall does
hold something back, the amount is measured and reported, not swallowed:

```
Carved face - flat shave, 4 x 4 mm face, 21.5 mm tall, depth 19.5 mm
  - 304.000 mm³ removed (held back 8.000 mm³ to keep the wall)
```

Gated: that cut is 19.0000 mm into a 20.0 mm block, leaving **exactly 1.0000 mm**
— minWall's promise, kept. The blade only reached 0.5 mm into the protected zone,
which is why 8 mm³ was held back rather than the full 16 mm³ of the wall.

Where the piece is thinner than the blade in *both* directions, the probe refuses
rather than guessing which way is out:

```
the faces within 2.00 mm point opposite ways - the wall is thinner than this
blade. Use a smaller blade or aim away from the edge
```

and a blade that fits the same 2 mm floor carves it cleanly (gated).

## 9. Three things the build found, and what each cost

None of these were visible from the audit; all three came out of the checker.

### a) The kernel's no-op guard is calibrated for plugs

`subtractSoupBFromA` refuses a boolean that removed less than
`max(1e-3, 0.01% of hull volume)`, because `subtractBFromA` **deletes bit B on
success** and a silent no-op would lose it. On an 80×40×20 block that floor is
6.4 mm³ — and the corner gouge legitimately removes **1.9 mm³**, 0.003%. The
first run of the real tool failed with
`removed ~0 volume (1.9086 mm^3) -- bit likely does not touch the hull skin`.

Fixed with `opts.minRemoved`, an override in `app-join.js`: absent it the
behaviour is byte-identical, so Subtract is unchanged. A carve passes an absolute
`1e-4` floor, because it deletes nothing and its real check is `removed` against
`intended` — which it measures with one extra `intersect` and prints. A carve
that would remove nothing is refused *before* the boolean, where the reason can
name the blade and the depth.

### b) float32 ULP seams at the cut boundary — the one real topology bug

The corner gouge came back **non-manifold at the canonical weld and manifold
below it**, which is the signature of a mesh with features finer than the
tolerance it is judged at. The two offenders, found by measurement:

```
(40.000000, 18.639208, 19.999998)  <->  (40.000000, 18.639208, 20.000000)
(40.000000, 20.299997, 18.339209)  <->  (40.000000, 20.299999, 18.339209)
```

1.907e-06 apart — `2^-19`, exactly one float32 ULP at magnitude 20. Where the
cut crosses the box's own edge, a vertex that should be *on* that edge lands one
ULP off it. Four triangles carried such an edge. They are not degenerate (they
have area), so nothing dropped them, and the kernel's own counters read
`0 open / 0 non-manifold` because in *its* index space the mesh is sound. But
every gate in this project welds at 1e-4 first, and under that weld each of
those four collapses to a line.

The fix is to weld the output, with `NSO_buildAdjacency` + `NSO_adjacencyToRaw`
— the app's own distance weld (a vertex looks in its own cell and the 26 around
it, so a pair astride a bucket wall cannot slip through) which drops every
triangle two of whose corners welded together.

At **1e-4, the gate's own tolerance**, and not at `NSO_sculptWeldTol`'s
feature-scale cap. That cap exists to stop a weld eating a piece's detail, which
is right for smoothing and wrong for a mesh whose acceptance test is a fixed
weld: whatever the gate will fuse must be fused already, or the gate is measuring
a mesh that does not exist. Measured on a dome gouge, where the cap lands at
5.459e-05:

| weld | non-manifold | odd | winding | Euler | verdict | signed volume |
|---|---|---|---|---|---|---|
| none (kernel soup) | 4 | 4 | 10 | 4 | FAIL | 4155.7894 |
| the 5.459e-05 cap | 2 | 2 | 5 | 3 | FAIL | 4155.7894 |
| **a raw 1e-4** | **0** | **0** | **0** | **2** | **PASS** | **4155.7894** |

The volume is identical to four decimals in all three: the weld fuses seams, it
does not remove material. The cap was the worst of the three — it fused two of
the four and left a mesh that claimed to be welded and still failed.

What it costs, stated plainly: a genuine feature finer than 1e-4 mm would be
fused. That is 0.1 micron, 4000× under a 0.4 mm nozzle and under the canonical
checker's own resolution, so such a feature cannot survive the gate by any route.
If the weld ever does structural damage it appears as an open or non-manifold
edge in the adjacency's own counters, and the guard keeps the kernel soup instead
of committing it. The weld also improves the sliver population as a side effect:
worst aspect 53,144 → 17,597, smallest area 2.4e-08 → 6.4e-07 mm².

**Deliberately not done inside `subtractSoupBFromA`.** Subtract's own outputs
already gate clean on the inputs it ships with (§2), and widening the shipped
boolean would move numbers other checks pin. §10 carries it as a follow-up.

### c) A plane meet is not on a curved surface

The first version clustered normals at 5° and treated every distinct plane as a
distinct face. On a tessellated dome that reads three facets in reach as a
*corner*, and then snaps the blade to the meet of three **tangent** planes —
which for a convex surface is a point out in the air, outside the piece. The
blade removed **0.0000 mm³** on `fixtures/fixture_sphere_curved.stl`.

Two changes, both principled rather than tuned. The dihedral merge (§7) makes a
smoothly curved region one feature, so a gouge on a dome is a `face` carve, as
it should be, while a box corner stays a corner — the box numbers are unchanged
by it. And the plane meet is now bounded: it has to land within the blade's own
reach of a real surface point or it is not this feature, and the nearest surface
point is used instead. The dome now reads `face`, 1 feature from 16 merged
coplanar groups, and removes exactly blade ∩ piece.

## 10. Deferred, deliberately

Each of these is a real ticket, not a shrug.

**Free orientation in the pose model.** The app's placed-piece pose is quantised
Euler — `applyMeshRotation` composes `rotation.set(tipX·90° + tiltX + flipX·180°,
rotY, tipZ·90° + tiltZ)` with `rotY` in 90° steps and `tiltX`/`tiltZ` in 15°
steps — and `snapshotPlacedPose` saves those components, not `mesh.quaternion`.
Nothing in the app can represent an arbitrary orientation, so Seat works around
it by writing the quaternion directly (it survives a drag; any pose button
destroys it). Carve avoids the problem entirely by never making the blade a
piece. Threading a real quaternion through `applyMeshRotation` and
`snapshotPlacedPose` would touch every piece and every pose button for a need
with exactly one consumer, so it is **not** done here. When a second tool wants
free orientation, that is the ticket: one quaternion field, carried through both
functions and through the undo snapshot, with the Euler fields kept as the UI's
way of driving it.

**Wall thickness / nozzle safety as a reusable utility.** ~~Deferred.~~ **Done**
— `nso_thickness.js`, and its `cutClearance()` is now wired to the shared cut
core (`subtractSoupBFromA`), so a carve reports it on the same status line that
reports what it removed. See `docs/WALL-THICKNESS.md`.

`minWall` still guards one axis, and still decides what gets cut; that is
unchanged. What is new is that the other axes are now *measured and reported*.
The `fixtures/box_open.stl` corner case from §3c — 48.000 of 48.000 mm³ removed,
a 2 mm near wall severed, the result still gating clean — was the test case that
thread wanted, and it is now the case the wiring is pinned on
(`npm run wall:cut`): the cut still removes its 48.000 mm³ and the status line
says `WALL SEVERED: cut severs the piece across z ... reported, not blocked`.

Deliberately a **warning and not a refusal**, for this document's own reason: a
corner gouge that cuts through a wall is what this tool is *for*. Blocking it
would have retired the feature, not guarded it.

**Slivers at a curved cut boundary.** Measured above: 24–93 triangles over
aspect 100, none collapsed, not gated by canon. They are cosmetically poor and
they make later booleans on the same piece harder. `NSO_Repair` already carries
the machinery (T-junction repair, flap peeling). Whether a carve should run a
targeted cleanup over just the cut boundary — and what that costs in volume — is
its own measurement, not a line to bolt on here.

**Paint scope.** Carve does not yet read the exclude mask. By the scoping rule
in `docs/HANDOFF.md` and `nso_inside_corners.js`'s header, a carve is
unambiguously a **sub-region** op — it touches one local spot — so the right
behaviour is to stand down when the faces it actually engages are painted
excluded, and to ignore paint anywhere else on the piece. That needs the probe's
feature clusters mapped onto the mask's face entries, which is real work and not
a line to bolt on; doing it badly would either ignore an exclusion the user set
or refuse a carve nowhere near the painted face. Until then Carve ignores paint
entirely, which is at least *predictable* rather than half-right. Flagged rather
than skipped quietly.

**The same weld for Subtract's output.** §9b's weld is a carve-local fix. A
curved bit through the shipped Subtract would hit the same float32 ULP seams, and
the audit only proved Subtract clean for *box* bits on *box* hulls. Worth
measuring; it moves numbers other checks pin, so it needs its own run.
