# Seat here — seating a piece against a curved or irregular target

**Positioning only.** This ticket answers *where the second piece goes*. The
**shape** of the contact — a mating face cut to follow the curve, a compliant
pad, a cup — is a separate, later layer and is deliberately not here. See
[Deferred: contact geometry](#deferred-contact-geometry), which is not a
hand-wave: the boundary is measured, and the positioning is exact *despite*
the shape being unmodelled, which is what makes deferring it safe.

| | |
|---|---|
| core | `nso_seat_surface.js` — pure geometry, browser + Node |
| wiring | `app-seat-surface.js` — the **Seat here** button in the Join card |
| audit | `tools/nso_seat_curved_audit.js` — `npm run seat:curved-audit` |
| gate | `tools/nso_seat_surface_test.js` — `npm run seat:surface`, in `npm test` |
| distance checker | `tools/nso_soup_distance.js` — `npm run dist:selfcheck`, in `npm test` |
| gap control | the existing `#seat-gap` slider, and the existing sign convention |

---

## 1. Task 1 — the audit

Run `npm run seat:curved-audit`. Exit 0 means every finding below still holds.
Every number in it is measured through the real app in real Chromium, against
the repository's own curved fixtures, with the shipped `Seat flush` and
`Seat (support)` buttons and the shipped core `NSO_seatFlushBitToHull`.
Nothing is asserted from reading source.

The ticket asked which of two things happens on a curved target: a refusal,
or a silently wrong pose. **Both do**, in different cases.

### a) The corner-ray gate is the wall — it refuses, like a straddle

`NSO_seatFlushBitToHull` casts four rays from the corners of the bit's **outer
box face** along one axis and fits a plane to the four hits. A curved target
falls away from any flat footprint, so those corners overhang it and the ray
finds nothing. Measured, all four cases refusing on **both** buttons with
`corner N missed hull along punch axis`:

| pairing | corner rays that missed |
|---|---|
| 20 mm bit centred over the 20 mm sphere | 4 of 4 |
| 12×8×8 bit 5 mm off the sphere's crown | 2 of 4 |
| 12×8×8 bit over the genus-1 groove | 4 of 4 |
| 20 mm bit over the organic blob | 4 of 4 |

A refusal moves nothing, which is the one thing that was already right.

### b) Where the rays *do* land, the gap path measures the right minimum — and calls a sphere a skin

12×8×8 bit centred on the sphere's crown: all four rays land, the tips probe
measures a rise of **3.1051 mm** against a `NSO_SEAT_TIPS_TOL` of 0.01, so gap
mode takes the **skin-tips** branch. The measurement is right — the true
minimum surface distance comes out at exactly the requested 0.18 mm — but the
user is told:

```
Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)
  - from skin tips, relief 3.11mm above the base plane
```

A bare sphere, reported as a 3.11 mm printed relief. And the pose is a pure
translation: the rotation written is **0.0000°**. The seat never orients the
piece to the surface, so only a target whose local normal already matches the
piece's mating face can be seated at all.

### c) The flush path has no tips probe, so on a curve it reports success with a large residual

`proud` mode never probes the tips. A 3 mm rod stood on end over the crown
seats on the corner-ray **plane** path and reports `maxResidual` **0.4754 mm**
against a requested 0.01 — 47× the offset asked for, reported as a success.

### d) The footprint is the bit's box face, not its contact outline

Measured on `fixtures/fixture_blob_organic.stl`, requesting a 0.18 mm air gap:

| bit | reported | true minimum distance |
|---|---|---|
| round rod (`fixtures/pin.stl`, a cylinder) | −0.1800 | **0.2053** |
| flat 12×8×8 bit | −0.1800 | **0.1737** |

Wrong in both directions, for two different reasons: the rod's square
footprint over-reaches the circle that actually touches, and the blob rises
*outside* the footprint and comes closer to the bit's flank than to its mating
face. The control says it is the footprint and not the rod: the same rod on the
sphere's **crown** is exact (0.1800), because there the extreme is the pole,
dead centre of the footprint and inside the circle.

Neither error is noise. The whole easy-release window is 0.05 mm wide; these
are 0.0253 mm and 0.0063 mm.

### e) There is no way to aim at a point

`NSO_seatFlushBitToHull(hullMesh, bitMesh, opts)` takes no target. The piece's
own pose is the only input, and the frame is derived from the hull's centroid.

### f) A free orientation does not survive the export

This is the finding that decided the design. `buildCombinedGeometry` — what
**Export plate** writes — rebuilds each piece's rotation from the quantised
pose fields (90° yaw, 15° tilt/bank) and **never reads `mesh.quaternion`**.
The shipped tilt fit writes there anyway. Measured: a 0.3 rad tilt takes the
scene's bounding box from 20 to **25.017 mm** in height and leaves the
exported box at **20.000**, with every pose field still zero.

So a seat that tilts through the quaternion **cannot be gated through the
canonical checker at all** — the file does not carry what the screen shows.

### What was reusable, and is reused rather than rewritten

- **`NSO_Carve.probeTarget`** (`nso_carve.js`) already turns an arbitrary world
  point on an arbitrary surface into a local frame, with a dihedral merge that
  reads a tessellated dome as *one smooth face* instead of a field of edges.
  That is the feature identification a seat needs, and it is the same frame a
  carve is placed in, so a seat and a carve aimed at the same point agree by
  construction.
- **`NSO_Skin.supportExtreme`** (`nso_skin.js`) already measures the outermost
  point of a surface along a direction over a quad footprint, clipping every
  triangle to it. It is the measurement the validated skin-tips seat stands on,
  and its frame comes from the footprint's own corners, so it serves a *tilted*
  mating face as it stands.
- **Local-Carve's contained pose-state decision** (`app-carve.js`, and
  `docs/LOCAL-CARVE.md`, "Deferred: free orientation in the pose model") is the
  precedent for finding (f), reached from the other side. The blade stays out
  of `state.placed` so it never meets the pose model. A *seated* piece has to
  be in `state.placed`, so instead the pose model must never be handed
  anything it cannot hold — see §3.
- **The gap sign convention** is the one locked in
  `tools/breakaway_coupons.py` and shipped on the `#seat-gap` slider:
  **negative = an air gap of that size, positive = penetration by that much,
  0 = touching.** Nothing new is invented, and the same slider is the control.

---

## 2. Task 2 — the positioning

Three steps. The first two are the *frame*; the third is what makes the gap
mean something.

### a) The contact frame, at an arbitrary point

`NSO_Carve.probeTarget` identifies the feature — one smooth face, a real edge,
a real corner — and hands back an outward bisector, a sweep tangent and the
closest real surface point.

**Its outward direction is not used as the normal.** It cannot be: `probeTarget`
buckets triangles whose normals are within 5° of each other and keeps the
**first** one's normal as the bucket's, weighted by the bucket's total area, so
on a finely tessellated dome the answer depends on triangle order. Measured on
a 240 × 480 sphere of radius 10: **up to 2.5° off** the analytic normal, and a
finer mesh does not improve it.

A carve does not care — a blade is aimed, not seated. A seat does: 2.5° across
a 12 mm footprint is a quarter of a millimetre at the far edge, five times the
whole easy-release window.

So the **normal is measured** in `nso_seat_surface.js`'s `refineNormal`, over
the same neighbourhood: the true area-weighted mean of the triangle normals
whose closest point to the aim is inside the radius and which belong to the
feature `probeTarget` picked. For a smooth surface that neighbourhood is
symmetric about the tangent point, so the mean *is* the tangent normal.
Measured against calculus on a sphere, at five aim points, on a coarse mesh
and a fine one: **0.0000°–0.1825°**, both meshes, which is the evidence that
the accuracy is not the tessellation's.

At a real **edge** or **corner** the feature is a bisector, not a surface
normal, so it is left exactly as `probeTarget` built it — a box edge still
comes back as the 45° diagonal to 1e-6.

The radius the orientation is read over is deliberately **not** the footprint:
a flat face on a dome touches near one point, and averaging over the whole
footprint would tilt the piece to the *chord* of the curve instead of its
tangent. Default: a quarter of the piece's smallest extent, never below
0.5 mm (`NORMAL_RADIUS_FRACTION`, `NORMAL_RADIUS_FLOOR`; `opts.normalRadius`
overrides).

### b) The mating face, and the smallest turn that does the job

The mating face is a face of the piece's own local axis-aligned box — the same
convention `NSO_plugFrame` / `NSO_matingFaceCorners` use. Which one is picked
comes from the **target**, not from the hull's centroid: the box face already
looking most nearly at the contact. So the rotation is the smallest one that
puts that face flat on the tangent plane, and because six axis directions
cover the sphere it is never more than 54.74° whatever the piece's pose.

The roll about the contact normal is left alone (minimum rotation) unless
`opts.roll` asks for one. `opts.maxTiltDeg` caps the turn and refuses past it;
`opts.center` (default on) puts the mating face's centre on the aim point,
because on a curve there is no "straight down" that preserves an XZ position
meaningfully — the point *is* the instruction.

### c) The offset — solved on the real quantity

The support rule places the mating **face** against the target's outermost
point over the footprint quad. That is the validated rule (it is what
`Seat (support)` does against a skin's tips) and it is exact when the contact
really is that quad — a flat-faced bit on a flat or convex face, which is every
case the shipped seat was validated against.

It is not exact otherwise, and audit finding (d) says so in both directions.
So the offset along the contact normal is **solved**, by one bisection on the
true minimum distance between the two surfaces:

| request | what is solved for |
|---|---|
| `gap < 0` | the true minimum surface-to-surface distance **is** `|gap|` |
| `gap = 0` | **first contact** — touching, not overlapping |
| `gap > 0` | `gap` mm **past first contact** |

First contact is a separate solve from the gap, and has to be: `dist(t) = 0`
over a whole interval, because every offset that penetrates measures zero. So
it is *bracketed* — the largest offset that still touches, holding
`dist(lo) = 0` and `dist(hi) > 0` all the way down — rather than inverted.
Inverting it as though it were monotone-invertible is how a "touching" seat
ends up 0.14 mm clear and a "0.05 overlap" ends up 0.10 mm deep; both were
observed before the bracket went in.

The `gap > 0` line is the generalisation that keeps the shipped convention
intact rather than replacing it. Where the contact **is** the footprint quad,
first contact and the support plane are the same offset, so "`gap` mm inside
first contact" is exactly "`gap` mm inside the outermost point under the mating
face", which is what `Seat (support)` has always meant. Where they differ, only
the shape-dependent rule was ever wrong.

It is fast enough to be a click. The prefilter takes the target down to the
triangles the piece could reach once, and the bisection then runs against
those: on `fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 32,862
triangles, one seat is **212 ms** end to end — 2,011 triangles culled to, 30
distance evaluations.

The bisection is sound because the piece is rigid and moves along one axis:
sliding it away from the target cannot reduce its distance to any triangle on
the approach side, and the prefilter keeps only those. It reports its own
iteration count and the reach it was allowed (`iterations`, `culledReach`,
`culledTris`) so a check can inspect the bracket instead of trusting it.

**The measured payoff**, on the pairing the audit caught the problem with —
the round rod on the organic blob, sixteen aim points spread over the blob's
own vertices, each seated twice and both measured independently:

| | requested | real clearance |
|---|---|---|
| support rule alone | 0.18 | up to **0.6084** (0.4284 out) |
| the solve | 0.18 | **0.18000 at all sixteen** |

### Two minimum-distance implementations, on purpose

The solve needs an exact minimum distance between two triangle soups, so the
core carries one (`NSO_SeatSurface.minDistance`). The **gates** measure with a
second, independent one (`tools/nso_soup_distance.js`, stdlib-only, with its
own self-check). `tools/nso_seat_surface_test.js` asserts the two agree to
1e-9 on the real fixtures. Same discipline as
`tools/nso_selfint_equiv_test.js`, for the same reason: a checker that shares
code with the thing it checks is not a checker.

Both compute it exactly rather than by sampling: `d = 0` if the triangles
touch, else the minimum over 9 edge/edge pairs and 6 vertex/triangle pairs.
Contact is tested separately because that 15-term minimum can be positive for
two triangles that genuinely cross.

**Why this quantity at all:** every Seat check before this one measured its gap
as a bounding-box difference along one axis, which is exact for two boxes and
meaningless against a dome. The closest approach between a flat face and a
sphere is at the pole and between a flat face and a groove at the groove's rim,
and neither is any box extreme of either shell.

---

## 3. The free orientation is baked into the piece, not posed

Audit finding (f): the export carries the quantised pose fields and nothing
else, so a free rotation on `mesh.quaternion` is invisible to every exporter.

`app-seat-surface.js` therefore never writes one. It rotates the piece's own
**raw soup** by the delta, expressed in raw axes, and leaves the pose fields
exactly as they were:

```
delta in display space  =  Q_pose⁻¹ · Δ_world · Q_pose
delta in raw space      =  Rx(+90°) · that · Rx(−90°)
```

because `display = rotateX(−90°)` of raw (`zUpToYUp` in `app-core.js`,
`rawResultToDisplayGeometry` in `app-cut.js`). The soup then goes through
`NSO_sculptCommitRaw` — the same commit Smooth, Skin, Carve, Scale and Delete
painted use — and `x` / `z` / `liftY` are re-fitted to the world box the plan
actually measured. Afterwards the piece is an ordinary unrotated piece as far
as Align, both exporters, Repair and *Check piece* are concerned, and the scene
and the file agree by construction.

A seat that needs **no** turn (the piece was already facing the target) skips
all of that: no geometry is touched and the undo entry is a plain pose
snapshot.

**One Seat here is one Undo.** `NSO_sculptCommitRaw` pushes the geometry entry
itself; the pose snapshot is attached to *that same entry* as `prevPose`, and
`app-core.js`'s replace-undo branch restores it after re-seating the placed
instance. Gated: the raw soup comes back bit for bit and `x` / `z` / `liftY` /
`mesh.position` come back exactly, in one press, and the label reads
`Undo: Seat here reverted`.

### PAINT SCOPE: WHOLE-PIECE

On the piece being seated, and only when the seat actually has to re-orient it.
The scoping rule is in `docs/HANDOFF.md`. Stated rather than left to be
re-derived:

- the **target** piece is only ever read, never modified, so its paint is
  untouched by construction and cannot block a seat;
- a seat that needs **no rotation** changes no geometry — it is a move — so
  paint on the piece being seated is untouched too, and does not block it;
- a seat that **does** rotate rewrites the whole soup in new axes. No
  sub-region survives that as itself: every face changes which axis it faces,
  so a mask recorded per axis and side would come back pointing at a different
  face. There is no sub-region to scope to, which makes whole-piece the only
  coherent reading — exactly as it is for Smooth, Repair, Thicken, Scale and
  Fusion.

Stand-down wording, when it must turn a painted piece:

```
Seat here stood down - 1 painted face(s) on B, and seating there turns B
44.5 degrees, which would leave the paint on a different face - clear it,
or seat a face that already looks at the target
```

---

## 4. The controls

**Seat here** sits in the Join card under `Seat (support)` and shares its gap
slider — the validated control, not a second one. Start Join, pick A and B,
press **Seat here**, and click the point on **A** where B should sit. It is an
armed click, like Carve and Measure: `app-core.js`'s `onCanvasPointerDown` asks
`window.nsoSeatHereTakesClick` before it starts a move drag, after Carve and
before Measure — before Measure because this one bakes, and a measurement must
never swallow a click a baking tool would have taken. Arming it disarms Paint,
Carve and Measure, and Measure's `disarmOthers` disarms it.

Status line, on success:

```
Seated on the face at that point - air gap 0.18mm (clearance 0.180mm)
  - B turned 44.5 degrees and baked into its own axes
```

`clearance` is re-measured on the two pieces as the scene holds them *after*
the pose has been fitted through `liftY` and the bed baseline, not copied from
the plan — so what is reported is what is there. The status also names the
feature the aim landed on (`face`, `edge`, `corner`) and says when no turn was
needed.

Before measuring, A is settled onto the bed baseline the way `Seat (support)`
does — and because this seat was aimed at a point on A's surface, the aim
travels with A by the same delta, since settling only ever moves a piece in y.

### What it leaves behind, and who else on the canvas it has to agree with

Two threads landed alongside this one, and both wanted something from a seat:

- **The seat record.** `NSO_recordSeat` (`app-join.js`) is what every Seat
  leaves on the piece it moved, and `Metadata/nso_scene.json` writes it, so a
  reopened plate says which gap a pair was seated at rather than only where
  the two pieces happen to sit. Seat here writes one too: `kind: 'support'`
  (it is a gap seat, not the plug seat), `measured` in the coupon sign so an
  air gap is negative, `reference: 'face'` — the schema's other value,
  `'tips'`, means the flat seat's skin-tips branch, which this one does not
  use. It records **no** `residual`, because it takes no corner-ray residual
  and the record's own normaliser reads a `null` as `0` — an absent key stays
  null. Gated end to end: the record on the piece, and the same numbers coming
  back out of `buildPlateSceneJson`.
- **One armed click at a time.** Arming Seat here turns off Paint, Carve,
  Measure and **Center lock**'s target pick; each of those turns Seat here off
  on the way in, through its own button, for the reason `app-center-lock.js`
  already writes down — a flag set behind a button's back leaves the button
  lit and dead. Leaving Join retires the arm with the slot, the way the Center
  lock target does, but **silently**: `clearJoinSlots` is tidying a session,
  not handing the canvas on, so it calls `nsoSeatHereDisarm` rather than
  clicking, which would print "Seat here off" over the line its caller had
  just set. All three are gated.

### Refusals

Each names what is wrong and moves nothing:

- the aim is off the piece → `nothing within N mm of that point - aim at the piece`
- the faces within the probe radius point opposite ways (a wall thinner than
  the probe) → `probeTarget`'s own refusal, unchanged
- the pose would put the piece below the plate → refused, with the depth,
  rather than clamped: clamping would silently break the gap
- the piece being seated is position-locked → `nsoPosLockBlocks`
- the click landed on B → `That is B. Click the point on A`
- the turn exceeds `opts.maxTiltDeg`, when a caller sets one
- the piece is wedged and the gap cannot be opened inside the solve's reach

---

## 5. Task 4 — the validation

`npm run seat:surface` (`tools/nso_seat_surface_test.js`), in `npm test`.
Three parts.

**Part 1 — the core, in Node, against analytic geometry**, so "the normal is
right" is checked against calculus and not against another piece of this
repository: five aim points on a sphere against the analytic normal, on a
coarse mesh and a fine one; a cylinder's radial normal; a box's face, edge and
corner still read as a face, an edge and a corner, with the 45° bisector to
1e-6. Then the whole gap range against the independent distance measurement,
the sixteen-aim-point blob scan above, six refusals, and the two
implementations agreeing to 1e-9 on four real fixture pairings.

**Part 2 — the shipped button, the real app, real curved fixtures, the real
export.** Eleven aim points across the 20 mm sphere (crown, equator, 45°,
off-axis), the organic blob (top, side, off-axis) and the genus-1 groove
(ring top, outer flank, dome at 45°, and the **concave inner wall**), plus the
flat block — the new tool on the old target. Each one:

- the aim is a real point on A's surface, found by A's own ray;
- the scene clearance is the requested 0.18 mm to 2e-5;
- no free rotation is on the mesh;
- **Export plate (STL)** goes through `tools/mesh_validate.py --json`: 0 open
  edges, 0 non-manifold edges, 0 piercing pairs, 0 coplanar pairs, and Euler
  equal to the target fixture's own plus the bit's 2 — *the target's own*,
  because `fixture_groove_concave` is genus 1, so its Euler is 0 and the
  plate's is 2, not 4. The constant would be wrong and the fixture is not;
- **the gate: the gap measured on the exported shells is 0.18 mm to 5e-5**, and
  the 3MF objects carry the same relation. This is the gate the shipped tilt
  fit could never have passed — turns of 5.6°, 23.4° and 44.5° all come out of
  the file intact;
- one Undo puts B back to the soup it was imported with, so eleven seats in a
  row cannot quietly stack eleven baked rotations.

Then the sign convention through the button on the sphere's 45° flank
(−0.25, −0.05, 0, +0.05 — the last one 0.05 mm past first contact to 1e-6,
with the canonical checker reporting 12 piercing pairs), **one seat driven by a
real mouse click on the canvas**, the one-Undo gate, the paint stand-down and
its converse, and the four app-level refusals.

**Part 3 — the regression.** `NSO_seatFlushBitToHull` is not touched by this
ticket: the gate asserts its signature is intact and that `app-join.js`
contains no reference to the new core at all. Then the flat-face behaviour is
re-pinned here as well as in `tools/nso_seat_gap_test.js`, so a change to
either file has to fail two suites:

- `Seat flush` lands on the golden pose to 1e-9 with the golden status line
  byte for byte;
- `Seat (support)` −0.18 on the flat block: status byte for byte, mating face
  0.18 above the skin to 2e-6, `liftY` 20.18 to 2e-6.

All four existing seat suites (`seat:gap`, `seat:align`, `seat:overhang`,
`seat:side`) and `paint:scope` pass unchanged.

### One thing the checker cannot see, stated not solved

A flat face tangent to a sphere touches at **one point**, and
`mesh_validate.py` has no class for that — it is neither a coplanar overlap nor
a piercing pair, so a `gap 0` seat on a curve reads 0/0 exactly as an air gap
does. (On a flat pairing the same seat produces coplanar contact, which
`tools/nso_seat_gap_test.js` pins.) What separates touching from an air gap
here is the measured shell-to-shell distance — 0.00000 against 0.05000 — and
the piercing pairs the +0.05 case produces. The suite asserts both and says so
in its own output.

---

## Deferred: contact geometry

Out of scope for this ticket, by Task 3, and the boundary is measured rather
than asserted.

The footprint the support rule measures over is the piece's local **box** face.
That is exact for a flat-faced bit and generous for a round one; audit finding
(d) is what a generous footprint costs if nothing corrects it. The clearance
solve corrects all of it *for the separation* — the gap that comes out is the
true minimum distance whatever the contact's shape — so the shape layer is not
load-bearing for positioning, which is precisely why it can wait.

What it would add, and what the solve does **not** give:

- **the contact patch** — how much area actually touches, and where. `gap 0` on
  a sphere is a point contact; on a flat face it is a plane. The seat reports
  the separation, not the patch. `NSO_Skin.tipContactArea` is the precedent for
  measuring one over a footprint.
- **a mating face cut to the curve** — a cup, a saddle, a compliant pad. That
  is a geometry bake on the piece being seated, not a pose, and it belongs with
  the curved-wrap ticket's relief builders rather than here.
- **the real contact outline in the support measurement** — replacing the box
  footprint with the piece's own silhouette. Worth doing for the reporting even
  though the solve no longer needs it.

The curved-wrap ticket — parked as "the OTHER wrap", landed as **Texture**
(`nso_skin_band.js`, `app-texture.js`, `docs/CURVED-SKIN.md`) — asked the open
question this ticket answers: *what `supportExtreme` and Seat mean against a
curved contact.* It offered two options, geometry-only or a second Seat mode,
and said the choice belonged to whoever took it. This is the second: Seat grew
a second mode, and it is positioning-only.

Texture's own geometry is untouched by this, and its gate that no part of it
calls `supportExtreme`, `tipContactArea` or a Seat entry point still holds —
this is a separate module and a separate button. Nor does this make a Texture
band a Seat target: Texture reports its relief's tip-surface area, and what
this seat measures is an interface between two pieces. Seating onto a curved
relief's tips is a third thing, and belongs with the contact-geometry layer
below.
