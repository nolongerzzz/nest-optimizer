# Curving paths — the audit, the primitive, and what it cost

`nso_path_sweep.js`, loaded from `index.html` at the existing `?v=inside4` tag
next to the other parked modules. **Not wired in**: it defines one global,
`NSO_PathSweep`, and runs nothing.

```
node tools/nso_path_sweep_test.js              63 checks: geometry, tolerances, refusals, probes
node tools/nso_path_sweep_canonical_check.js    9 checks: 8 stages + a negative control,
                                                 each written to a real STL and handed to
                                                 tools/stl_watertight_check.py --odd --degen
```

Both are in `npm test`.

---

## 1. The audit: what the pose system is, exactly

The ticket's premise was that the app has no representation for a curving or
multi-segment path. That is correct, and the precise shape of the gap matters
more than the fact of it, because it determines what a path type can and cannot
be bolted onto.

**A pose is nine loose scalars on a placed entry.** `placeModelMovable()` in
`app-core.js:1235` creates it, `applyPlacedOrientation()` at `:1223` copies it,
and `applyMeshRotation()` at `:2987` is the only thing that reads it back:

```js
p.mesh.rotation.set(tip + flip, p.rotY || 0, roll);   // three.js default XYZ order
p.mesh.position.set(p.x, p.height / 2 + 0.2 + lift, p.z);
```

with `tip = tipX·(π/2) + tiltX·(π/180)` and `roll` the same in Z. So the full
state is `{ x, z, rotY, flipX, tipX, tipZ, tiltX, tiltZ, liftY }`. Four
consequences, each of which rules something out:

1. **It is not composable.** Euler angles in a fixed order, stored as separate
   quarter-turn counts and degree offsets, with no matrix or quaternion
   anywhere in the placement path. There is no "pose × pose", so a chain of
   stations cannot be expressed by chaining poses.

   This is not only an architectural observation. The pose-after-bake thread
   reached the same root cause from the other end and found it already
   biting: `tools/nso_pose_after_bake_test.js` records that **a composite pose
   — two or more of `rotY` / `tipX` / `tipZ` at once — already disagrees
   between viewport and exporter with no bake anywhere near it**, because
   `applyMeshRotation()` sets a THREE Euler in XYZ order while
   `buildCombinedGeometry()` calls `rotateX`, `rotateY`, `rotateZ`, which
   composes in the reverse order. Nine loose scalars with no composition rule
   is exactly the shape of defect that produces. It wants its own pass, and it
   is not this ticket's.
2. **Y is not free.** `applyMeshRotation` recomputes `position.y` from the
   rotated bounding box on every call. A pose says "this piece, resting on the
   plate, nudged up by `liftY`". It cannot say "this thing, here in space".
3. **There is no direction in it.** No tangent, no frame, no up-vector. The
   nearest thing to a frame in the whole app is `frame.axis`/`frame.punch` in
   `app-join.js`'s `buildCutVolume`, which is a cardinal-axis-plus-sign
   descriptor for a cutting box, not an orientable frame.
4. **It is about a whole placed instance, not about geometry inside a piece.**
   Every bake — Cut, Smooth, Repair, Fusion, pocket corners — works on
   `rawTris` in the model's own local frame and commits through
   `NSO_sculptCommitRaw`. A path is neither: it is an internal generator that
   produces new soup.

**There ARE curves in the tree — and none of them is a path.** This paragraph
originally read "there is no curve object of any kind", which was true of the
branch point this work started from (`2a6d07a`) and is **false of the tree it
merged into**. Three things landed in between, and each is worth naming
precisely, because "there is a spline over there" is exactly the kind of
half-fact that gets a later ticket pointed at the wrong file:

- **`app-wheel.js` (Pottery Wheel)** fits a *monotone cubic Hermite*
  (Fritsch–Carlson) through the potter's drag points and revolves it. But the
  curve lives in the **(z, r) half-plane** and is swept about a **fixed
  axis**: there is no 3D path, no tangent to follow and no frame to carry.
  `NSO_wheelRevolve` walks meridian × angle. A surface of revolution is not a
  swept path, and the wheel's spline cannot describe one.
- **`nso-gcode-lines.js` (toolpath import)** does carry real 3D polylines —
  they are the sliced toolpath. But see §1a: it renders each move as its own
  closed box, so the polyline never becomes a continuous solid, by design.
- **`nso_skin_band.js`** treats a band rim as a closed polyline. That is a
  parameter curve **on an existing surface**, used for seam bookkeeping; it
  generates no geometry along a route.

What is still true, and is the whole point: **nothing in the tree represents an
oriented 3D path with a moving frame.** The boundary walkers in `app-cut.js`
and `app-finish.js` still throw on "branch point in cap boundary" — a *ring*
walker, refusing exactly the degree-3 vertex a tree needs. Overhang handling is
still a colour (`app-core.js:1719`, "green = OK, red = needs support"), not
geometry. three.js 0.147 is loaded in full, so `CatmullRomCurve3` and
`TubeGeometry` are available; neither is referenced anywhere.

**One correction that goes the other way, and it is a gift.** This section also
claimed the nearest thing to a frame in the app was `frame.axis`/`frame.punch`
in `app-join.js`'s `buildCutVolume`. That is no longer true.
`NSO_Carve.probeTarget()` in `nso_carve.js:425` turns an arbitrary world point
on an arbitrary surface into a real oriented frame — `{ outward, tangent,
point, surfacePoint, kind }` — with dihedral clustering so a tessellated dome
reads as one smooth face rather than a field of edges, and a named refusal when
the faces within reach point opposite ways. That is precisely the frame the
*first station* of a support branch needs, and `sweep()`'s `opts.up` already
takes exactly that kind of seed vector. See Q4 and Q5.

So: the gap the ticket named is confirmed and is still new architecture. What
changed is that the attachment end of it now has something real to stand on.

### 1a. Three alternatives, and why this one

**`THREE.TubeGeometry`.** Rejected. It is a display-geometry generator: it
produces an open tube with no caps, a duplicated UV seam, and vertices
positioned by sampling a curve at a tolerance. The app's currency is a
watertight triangle soup that has to survive `--odd --degen` and a boolean
kernel. A seam of duplicated vertices is exactly the open-edge failure the
checker exists to catch.

**CSG union of per-segment capsules.** `NSO_CSG` (manifold-3d) is already live
in `app-join.js:1125` and already used by `nsoUnionSoups`. Unioning a capsule per
segment would be robust and would handle junctions for free. It was not chosen
for the *primitive*, for three reasons: it destroys the cross-section (the
kernel retriangulates, so "the section is the profile" stops being true and
stops being checkable), its triangle count is unpredictable, and it is async
and wasm-gated where this needs to be a pure function. **It is, however, the
right tool for the junctions this primitive cannot do — see §5.** The two are
complementary, not rivals.

**One separate solid per segment, left overlapping.** Rejected here — and this
option is no longer hypothetical, which is worth recording rather than
restating the rejection. `nso-gcode-lines.js`'s `extrudeFlatLine()` does
exactly this, shipped: every extrusion move becomes its own closed 12-triangle
box with its own start and end caps, and consecutive moves are never joined —
no shared ring, no miter, no continuity. Adjacent boxes simply abut and
overlap.

That is the right answer *there* and the wrong one here, and the difference is
the job, not the quality of the code. Its own header scopes it: "This is an
IMPORTER AND RENDERER, nothing else." It draws hundreds of thousands of moves
for a human to look at, so per-move independence is what makes it tractable and
what lets `moveOfTriangle()` map any triangle back to the move that printed it.
A support branch is the opposite: one object, printed, which has to survive
`--odd --degen` and a boolean kernel. A union of overlapping boxes is not a
solid, so no gate in this repo can say whether it is correct — and the
toolpath importer does not need one to.

---

## 2. The representation

Minimum viable, and deliberately smaller than a spline:

```js
{
  points:  [[x,y,z], ...],   // N >= 2 stations, in the model's own frame
  profile: [[u,v], ...]      // one closed convex CCW polygon, origin inside
}
```

Everything else is derived and nothing else is stored:

- **segment directions** `u_k`, one per segment;
- **one orthonormal frame per segment**, seeded on segment 0 and carried across
  each joint by the *minimal* rotation (discrete parallel transport);
- **one joint record per interior station**: bisector normal `m`, turn angle,
  and the miter factor `1/cos(turn/2)`.

A spline was considered and is not needed yet. A spline has to be tessellated
into a polyline before it can become triangles, so the polyline is the real
primitive either way; a spline is a *source* of points, and it can be added
later without changing anything below it. `arcSubdivide()` is that, in its
simplest useful form: it replaces a corner with a tangent circular arc of `n`
chords.

### How it evaluates

For segment `k`, profile point `j` traces a **rail**: a straight line parallel
to `u_k`. At an interior station, the two segments are cut by their common
**bisector plane**, and the ring point is where rail `j` meets it. That choice
is forced, not preferred:

> Rail `j` of the incoming segment and rail `j` of the outgoing segment have
> equal components along the bend axis — the frame is carried across by a
> rotation *about* that axis, which fixes it. So both lines lie in one plane
> parallel to the bend plane. Two non-parallel coplanar lines meet in exactly
> one point, and that point is on the bisector.

So the joint ring is **one ring, reached identically from either side**. There
is no seam, no duplicated vertex and no weld tolerance in the construction at
all. `sweep()` computes each ring point down the incoming rail and then
recomputes it down the outgoing rail as an independent check.

This is Extend's argument, carried round a corner (`app-extend.js`,
`docs/EXTEND.md` — it landed on `claude-wip` while this branch was open, so the
argument it rests on is now reachable rather than quoted). Extend holds a
cross-section exactly because a triangle with `n·u = 0` lies in a plane
*containing* `u`, so
sliding its vertices along `u` leaves it in that plane. Here every side wall of
a segment has its four corners on two rails parallel to `u_k`, so the wall is a
planar quad whose plane contains `u_k` — the same fact, doing the same work.

---

## 3. Findings

### F1 — the joint closes exactly, with no tolerance in the construction

The two independent computations of each joint ring point agree to float64
rounding:

Measured over a 24-gon of radius 2 mm on 40 mm legs, at every angle from 5° to
170°:

| turn | worst incoming-vs-outgoing gap | in float32 ULPs |
|---|---|---|
| 5° | 7.105e-15 mm | 1.9e-9 |
| 45° | 7.109e-15 mm | 1.9e-9 |
| 90° | 2.220e-16 mm | 5.8e-11 |
| 150° | 1.455e-14 mm | 3.8e-9 |
| 170° | 1.997e-13 mm | 1.0e-7 |

The gate is counted in ULPs with a limit of 8; the worst case is seven orders of
magnitude inside it.

### F2 — every wall stays exactly planar through a bend

Worst out-of-plane deviation over all four corners of every wall quad, across
the same angle sweep: between 0.000e+0 and 8.9e-15 mm. Over the 9-point space
path (84 wall quads, no joint axis-aligned): 4.7e-15 mm. The planar-quad
property is what makes the two triangles of each wall exactly coplanar, so the
mesh has no non-planar-quad artefacts to speak of.

### F3 — volume is `profile area × centreline length`, exactly, at any bend angle

Same sweep, same 24-gon on 40 mm legs — `A·L` is constant because the
centreline length is, and the volume follows it whatever the bend does:

| turn | volume | A·L | relative error |
|---|---|---|---|
| 5° | 993.865110 | 993.865133 | 2.3e-8 |
| 45° | 993.865208 | 993.865133 | 7.5e-8 |
| 90° | 993.865205 | 993.865133 | 7.2e-8 |
| 150° | 993.865096 | 993.865133 | 3.7e-8 |
| 170° | 993.865109 | 993.865133 | 2.4e-8 |

All residuals are float32 storage noise. This is not a coincidence and it is
worth stating as a rule, because it is the cheapest correctness probe available
and it holds only under a condition a caller can break:

> The miter shift is a **linear** functional of the profile point. Its integral
> over the profile is therefore the shift at the profile's **centroid**. So the
> material a bend adds on the outside exactly equals what it removes on the
> inside — provided the profile's centroid is at the path.

`profileCheck` only requires the origin to be *inside* the profile, not at its
centroid, which is the weaker condition the cap fan needs. A caller that hands
in an off-centre profile still gets a correct solid, but loses this identity
and gets a branch whose material drifts to one side of its own centreline. A
later ticket that lets callers supply arbitrary profiles should decide
explicitly whether to re-centre them.

### F4 — a bend stretches the section, and this cannot be removed

The section taken **perpendicular** to the path is exactly the profile
everywhere inside a segment (measured by slicing the emitted soup, not by
trusting the construction: relative area error 4.5e-7, which is float32
storage). In the **bisector plane at a joint** it is not — it is the profile
stretched by `1/cos(turn/2)`:

| turn | predicted `1/cos(t/2)` | measured section / profile |
|---|---|---|
| 5° | 1.000953 | 1.000953 |
| 45° | 1.082392 | 1.082392 |
| 90° | 1.414214 | 1.414214 |
| 150° | 3.863703 | 3.863703 |
| 170° | 11.473713 | 11.473713 |

This is inherent to mitring a constant cross-section through a corner. **You
cannot have both a single watertight shell and an exactly perpendicular section
at a joint**, and any implementation that claims otherwise has either moved the
distortion somewhere less visible or stopped being one shell. It is named here
rather than hidden because a support branch at 90° is 41% fatter at its elbow
than along its legs, and that is a fact the caller has to plan around.

**The tree now hits `1/cos` at a crease in two places, and they answer it
differently on purpose.** `app-extract-sel.js` offsets each welded vertex along
the area-weighted average normal, "mitred by `1/cos` so a patch that turns a
corner still comes out `WALL_MM` thick on both sides of it" — and it **caps**
the blow-up at `MITRE_MAX = 3` rather than refusing. That is correct there and
would be wrong here, and the reason is structural rather than a matter of
taste. Extract-selection is thickening a shell inwards: a capped mitre leaves
the wall locally thinner than asked at a sharp crease, which is a visible
imperfection in a part that is still a closed shell. Here the joint ring has to
land **exactly** on the bisector plane, because that is the single fact that
lets the two segments share one ring with no weld; a capped miter would pull
the ring off that plane and tear the shell open. So this file refuses where
that one clamps. Neither is the other's bug.

### F5 — arc subdivision buys accuracy, **not** feasibility. This corrects the ticket's premise.

Splitting a 90° corner into `n` chords:

| chords | measured section / profile | `1/cos(t/2n)` | excess |
|---|---|---|---|
| 1 | 1.41421366 | 1.41421356 | 41.42137% |
| 2 | 1.08239234 | 1.08239220 | 8.23923% |
| 4 | 1.01959116 | 1.01959116 | 1.95912% |
| 8 | 1.00483865 | 1.00483857 | 0.48387% |
| 16 | 1.00120621 | 1.00120600 | 0.12062% |

The excess falls by 5.03 → 4.21 → 4.05 → 4.01 per doubling, converging on the
`t²/8n²` law. (It is *not* 4× at the coarse end, and reading the asymptote
outside its range would be reading it wrong — the suite checks both halves of
that.)

What it does **not** do is make a tight corner buildable. The arithmetic:

- a single miter needs `r·tan(t/2)` of segment on each side of the corner,
  where `r` is how far the profile reaches in the bend plane;
- an arc of radius `R` needs `R·tan(t/2)` of **tangent** for the same corner;
- and its own chords are only buildable while `R·cos(t/2n) > r`, so `R > r`.

`R > r` makes `R·tan(t/2) > r·tan(t/2)`. **Rounding a corner costs more segment
than mitring it, never less.** Measured directly: a 150° corner on 10 mm legs
is refused by the single miter, and *no* arc radius from 1 mm to 20 mm rescues
it. The module's refusal message says so, instead of sending the caller to a
tool that cannot help. (An earlier draft of this file, and of the module's own
comments, claimed the opposite. The measurement is what corrected it.)

### F6 — you cannot bend a tube tighter than its own section

The `R·cos(t/2n) > r` bound above is not an artefact of mitring. It is the
physical constraint on bending a real tube: below it the inside wall would have
to pass through itself. It predicts buildability exactly, including across the
boundary:

| arc R (profile r = 3) | `R·cos(t/2n)` | built? |
|---|---|---|
| 2 | 1.9904 | no |
| 2.9 | 2.8860 | no |
| 3.1 | 3.0851 | **yes** |
| 4 | 3.9807 | yes |
| 8 | 7.9615 | yes |

### F7 — the one gate that is not a proof, and where it bites

Two claims about self-intersection, and only one of them needs checking at run
time:

- **Proved, not checked.** A joint ring is an *affine* image of the profile
  (the miter shift is linear in the profile point), and an affine image of a
  convex polygon is convex. So a joint ring can never self-cross. That is why
  `profileCheck` insists on convexity — it buys a proof.
- **Checked, because it cannot be proved away.** The inside of a bend pushes
  its ring *backwards* along the rail, and once that push exceeds the segment
  length the wall inverts and the solid turns inside out. `sweep()` tests every
  rail of every segment for forward progress, and the flip point is exactly
  `r·tan(turn/2)`: measured for a 150° turn with `r = 3`, it flips between
  11.190 mm and 11.200 mm, against a prediction of 11.196 mm.

Note that this is a **ratio**, not an angle. A 150° turn is fine on 60 mm legs
and impossible on 2 mm legs with the same profile, so a fixed "maximum bend
angle" would be the wrong gate in both directions.

It also matters *which* magnitude each gate measures at, and the two gates on
segment length are deliberately different. `buildFrames` refuses a segment
shorter than 8 ULPs **of the path point**, because below that a direction read
from the difference is rounding. The per-rail gate measures 8 ULPs **of the ring
point**, millimetres out from the path, because that is where the triangles are
actually stored. A path sitting at 1e-3 mm with a 50 mm profile passes the first
and is caught by the second — measured, not hypothetical.

### F8 — the float32 tolerance lesson repeats, and this time it fails *quietly*

`NSO_weldEpsFor` and `NSO_sculptWeldTol` each learned that a weld distance
cannot be a constant. The same lesson arrives here from a third direction, in a
nastier form.

Reading a cross-section back out of the emitted float32 soup needs two
tolerances: how close two section points must be to be the same point
(`weldUlps`), and how near the cutting plane a vertex must be to count as *on*
it (`planeUlps`). The second one is not an optimisation — the section that
matters most is the one taken exactly in a joint's bisector plane, and there a
whole ring of vertices lies in the cutting plane, scattered a few ULPs either
side of it, with no sign to trust.

Slicing the same 45° bend at three placements, where the section **is** a
16-gon:

| offset from origin | fixed 1e-7 mm, both | strict plane test | float32-derived |
|---|---|---|---|
| 0 | 20 pts | 20 pts | **16 pts** |
| 100 mm | 22 pts | 20 pts | **16 pts** |
| 1400 mm | 38 pts | 24 pts | **16 pts** |

The failure is silent, which is the part worth carrying forward. A fixed
tolerance does not return nothing — it returns a closed loop enclosing the
**right area** with the wrong number of corners, because the duplicates it
failed to merge are collinear. A caller measuring area sees nothing wrong. A
caller comparing section vertices to profile vertices gets a 38-gon.

One honest negative: the seam gate (F1) reads as float64 noise at 0, 100 and
1400 mm, so *that* particular gate would have survived a fixed millimetre
tolerance here. It is still counted in ULPs, because the reason it is small is
that it is computed in float64 before storage, and a later change that moves
that arithmetic into the stored buffer would break it silently at 1400 mm and
nowhere else.

### F9 — the frame has to be parallel-transported, and a world up-vector is worse than it looks

Frames are carried across each joint by the minimal rotation, whose axis is
`u_prev × u_next`. Measured over a 4-segment out-of-plane path: orthonormality
holds to 2.2e-16 and accumulated roll about the tangent is exactly 0.

The usual shortcut — project a fixed world up-vector onto each segment — fails
twice, and the first failure is the one that matters here:

- **It has no frame at all on a vertical segment**, because the projection
  vanishes. A support branch leaving the plate is exactly that segment, every
  time. This is not an edge case for this application; it is the common case.
- **Where it is defined, it still twists.** On a tilted 3-segment path it rolls
  64.5° over two joints, against 0 for parallel transport.

A closed loop is a separate matter: parallel transport does not close on itself
(holonomy), so a closed path would end with a frame rotated from where it
started. Out of scope — see §6.

### F10 — what a flare costs

The Bambu shape this ticket points at is a branch that *widens* into a mesh
interface rather than necking to a point. That is a per-station profile scale,
and the probe measures the one property that breaks:

| | worst wall out-of-plane |
|---|---|
| taper along a **straight** run | 1.0e-15 mm (a cone frustum face is a flat trapezoid) |
| taper through a **mitred bend** | **6.1e-2 mm** |

61 microns of non-planarity on a 2 mm section over a 45° turn — a fifth of a
layer, and it grows with the taper rate and the turn angle. The algebra behind
it: on a straight segment the scaled rails stay coplanar, so a frustum face is
flat; through a miter the two ends' rail offsets differ by a term along `u`
that is *not* in the wall's span, and the quad opens up.

This does not make a flare impossible. It means a flare cannot be added by
scaling rings and keeping everything else, because the "every wall is a planar
quad" property that the whole correctness argument rests on stops being true.
The fix is knowable and is the next ticket's first decision — see §5.

### F11 — float32 storage at 1400 mm costs two decades of volume precision

Same 45° bend, same code: volume error against `A·L` is 7.8e-8 at the origin
and 2.6e-6 at 1400 mm. Nothing is wrong; it is the float32 grid, 1.2e-4 mm wide
out there. Worth writing down because a volume probe used as a gate needs its
threshold scaled to placement, like everything else in this file.

---

## 4. The canonical checker, stage by stage

`tools/nso_path_sweep_canonical_check.js` writes a real binary STL per stage and
runs `tools/stl_watertight_check.py --odd --degen` on it as a separate process.

| stage | tris | verts | open | non-mf | odd | degen | Euler | A·L err | checker |
|---|---|---|---|---|---|---|---|---|---|
| 1 straight (2 points) | 64 | 34 | 0 | 0 | 0 | 0 | 2 | 3.7e-8 | clean |
| 2 single 45° bend | 96 | 50 | 0 | 0 | 0 | 0 | 2 | 7.8e-8 | clean |
| 3 150° bend, roomy | 96 | 50 | 0 | 0 | 0 | 0 | 2 | 3.2e-9 | clean |
| 4 150° bend, 2% inside the gate | 96 | 50 | 0 | 0 | 0 | 0 | 2 | 2.6e-8 | clean |
| 5 90° rounded into 8 arc chords | 440 | 222 | 0 | 0 | 0 | 0 | 2 | 2.4e-7 | clean |
| 6 9-point space path, 7 joints | 216 | 110 | 0 | 0 | 0 | 0 | 2 | 1.0e-9 | clean |
| 7 stage 2 at +1400 mm | 96 | 50 | 0 | 0 | 0 | 0 | 2 | 2.6e-6 | clean |
| 8 0.4 mm section (one nozzle) | 72 | 38 | 0 | 0 | 0 | 0 | 2 | 2.0e-6 | clean |
| 9 **negative control** — stage 2 with 3 triangles removed | | | 5 | | | | | | **refused** |

Stage 9 exists because a clean row means nothing unless the gate can bite. The
3MF drive check in this repo once passed for the wrong reason; the lesson was to
prove the check fails when it should.

Counts are exactly as predicted: `2·M·(segments+1)` triangles, `M·rings + 2`
vertices, `3·M·rings` edges, Euler 2 throughout.

---

## 5. Open design questions — read this before the next ticket

These are real and none of them is answered here.

**Q1. A tree is a graph, not a path. This is the big one.** Everything above is
defined for a degree-2 station. A Y-junction where two branches merge has
**no bisector plane**, so the entire miter construction is undefined there.
This is not a gap to be patched — it is a different geometric problem.

Recommendation, and it is the main architectural recommendation of this ticket:
**do not try to make the sweep handle junctions.** Use it for strands and use
`NSO_CSG` — already live in `app-join.js`, already used by `nsoUnionSoups` —
for the nodes: sweep each strand as its own watertight solid, union them at the
junctions. The sweep keeps its exact cross-section along every strand where it
matters, and the kernel handles the one place where "exact cross-section" has no
meaning anyway. That split also matches how the two behave: the sweep is a pure
synchronous function, the kernel is async and wasm-gated, and junctions are rare
while strand geometry is everywhere. The obvious cost — the kernel
retriangulates near a junction, so section exactness stops holding in a
neighbourhood of it — has not been measured. Measuring it (how far from a
junction does the section recover?) is a cheap, self-contained follow-up and
should come before any commitment.

**Q2. Where does a flare's scale change live?** F10 says scaling rings breaks
wall planarity through a miter. Two candidate rules, both unimplemented:
  - *Scale is a property of stations, constant across each joint.* Cheapest,
    but it does not restore planarity — the two ends of a segment still carry
    different scales, which is exactly what F10 measured.
  - *All scale change happens strictly inside segments, joints are
    scale-neutral.* This does restore the frustum argument per segment, at the
    cost of forcing a flare to sit on straight runs. For a support branch that
    flares only at its two ends, this may be free.
  Either way, the wall stops being one planar quad and the winner needs a rule
  for splitting it consistently, since the diagonal choice is no longer
  arbitrary.

**Q3. Global self-intersection is not checked.** F7's gate is *local*: it stops
a joint from eating its own segment. A path that loops around and passes
through itself several segments later produces a perfectly manifold,
perfectly wound, self-intersecting solid, and every gate here passes it.
`tools/mesh_validate.py` (on `main`, not on this branch) and `NSO_Repair`'s
`countSelfIntersections` both already do triangle/triangle work. One of them
should be pointed at this, and the result gated — as a *refusal*, since the
checker cannot repair it.

**Q4. Who supplies the path?** This ticket deliberately took `points` as an
input. Auto-routing — pick an overhang, find the plate, avoid the model — is a
separate problem that should not be designed through this API. What this API
owes it is only that a path is a plain array of points, which it is.

The **first** station, though, is no longer an open problem, and that changed
while this branch was open. `NSO_Carve.probeTarget()` (`nso_carve.js:425`)
already turns a world point on an arbitrary surface into
`{ outward, tangent, point, surfacePoint, kind }`, clustering coplanar faces by
dihedral so a tessellated dome reads as one face, and refusing by name when the
faces within reach point opposite ways. `surfacePoint` plus a step along
`outward` is the first path segment; `tangent` is a natural `opts.up` seed. A
branch-attachment ticket should start there rather than measuring a surface
again — the same reuse argument `nso_seat_surface.js` already makes for Seat.

**Q5. Attachment, and the paint rule.** Nothing here touches a placed piece,
so no paint category applies (see §7). The commit path such a ticket would use
is `NSO_sculptCommitRaw`, which now restores the pose after a bake rather than
leaving the placed mesh rebuilt at identity (`tools/nso_pose_after_bake_test.js`,
`npm run pose:bake`) — worth knowing before writing another one. The moment a
ticket attaches a branch to a surface, *that* feature is the paint-aware one
and takes a row in the HANDOFF roster. Which category it lands in depends on whether attachment has an
identifiable footprint on the target — a question about the attachment, not
about the sweep — so it must not be pre-decided here.

**Q6. Closed paths.** Parallel transport has holonomy: a closed path ends with
its frame rotated relative to where it started, so the first and last rings do
not line up. Out of scope. A closed path needs the standard residual-twist
correction distributed over the path, which changes the frame rule and would
invalidate F9's "zero roll" measurement.

---

## 6. Out of scope for this ticket, named

1. **Tree topology / junctions** — Q1. Nothing here builds a Y.
2. **Flaring or tapering branches** — Q2. Probed and measured, not implemented.
3. **Auto-routing** — Q4. Paths come in as data.
4. **Attachment to a piece, and undo/UI** — Q5. No bake, no undo entry, no
   button. `NSO_sculptCommitRaw` is the obvious commit path when a ticket wants
   one, and nothing here presumes it.
5. **Global self-intersection** — Q3. Locally gated only.
6. **Closed paths** — Q6.
7. **Non-convex profiles.** Refused. Convexity is what buys the "a joint ring
   cannot self-cross" proof; a non-convex profile would need that proof replaced
   by a run-time ring test.
8. **Splines.** `arcSubdivide` is the only point generator here. Anything
   fancier produces points and feeds the same `sweep()`.
9. **Matching real tree-support quality.** Explicitly not attempted, per the
   ticket. What exists is a correct curving primitive.

---

## 7. PAINT SCOPE: NOT APPLICABLE (generator, not a bake)

Per the scoping rule in `docs/HANDOFF.md`, a paint-aware feature is one that
modifies an existing piece, and must declare whether it acts on a sub-region or
on the whole piece. `nso_path_sweep.js` does neither: it takes numbers and
returns a new soup, and never reads, writes or touches a placed model. There is
no face on any existing piece it could move, so there is nothing for a skip list
to protect, and it takes no row in the roster.

That changes the moment a ticket attaches a branch to a piece. See Q5.
