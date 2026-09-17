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
