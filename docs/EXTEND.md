# Extend — axis-preserving stretch

`app-extend.js`, wired into `index.html` at the existing `?v=inside4` tag,
loaded straight after `app-sculpt.js` because it reuses that file's commit
half and its measurement helpers.

```
node tools/nso_extend_test.js             headless: geometry, tolerances, refusals
node tools/nso_extend_canonical_check.js  canonical checker before/after, machine-compared
node tools/nso_wire_extend_test.js        the real app, real clicks, real undo
```

All three are in `npm test`.

## What it is

Extend lengthens a piece along **one** straight axis and holds the
cross-section perpendicular to that axis **exactly** fixed. Not "to within a
tolerance" — the two coordinates that are not the axis are copied through bit
for bit, and a gate inside `NSO_extendRaw` compares them element by element
against the input on every run and refuses if even one moved.

That is the whole point, and it is what makes Extend a different tool from
Scale-to-size rather than a special case of it. A piece's functional numbers
live in its cross-section: a living hinge's flex thickness, a hinge barrel's
bore, a boss's screw clearance, a cable channel's internal width. A uniform
scale moves every one of them. Extend moves none of them.

## API

```
NSO_extendUlp32(m)                              -> float32 spacing at magnitude m
NSO_extendTriTol(soup, o, axisIdx, k, cap)      -> per-triangle derived tolerance
NSO_extendAxisCensus(soup, axisIdx, opts)       -> perp / cap / oblique area split
NSO_extendCovarianceAxis(soup)                  -> best straight axis over all directions
NSO_extendDetectAxis(soup, opts)                -> { ok, reason, axisIdx, axis, census }
NSO_extendBands(soup, axisIdx, opts)            -> clean constant-cross-section bands
NSO_extendLengthToReach(soup, axisIdx, coord)   -> { min, max, current, length, gap }
NSO_extendRaw(soup, opts)                       -> { ok, reason, tris, before, after, ... }
NSO_extendSelectedModel(opts)                   -> paint check + bake + undo entry
```

`NSO_extendRaw` opts: `length` **or** `delta`, plus `axis`, `cut`, `gate`,
`maxOblique`, `tieFrac`, `offAxisDeg`, `perpK`, `maxPerpTol`, `minBandFrac`,
`minBandUlps`, `lengthUlps`. On refusal `ok` is false and `tris` is the
**original** soup object, so a caller can swap unconditionally — the same
contract `NSO_smoothGlobal` has.

## How it works, and why it is exact

1. **Census.** For each of X, Y, Z, split the surface area three ways by
   normal: `perp` (`|n·u| ≈ 0`, a side wall), `cap` (`|n×u| ≈ 0`, an end
   face), `oblique` (everything else — a taper, a chamfer, a curve). The
   census knows nothing about legs, struts, straps or barrels, and must not
   learn; it is a pure normal-distribution measurement.

2. **Axis.** Least oblique area wins. Ties in straightness go to the longer
   axis.

3. **Band.** The vertices' coordinates along the axis fall into distinct
   layers. A gap between two consecutive layers is **clean** when every
   triangle straddling it is perpendicular to the axis.

4. **Cut and translate.** Cut at the middle of the widest clean band; add
   `delta` to the axis coordinate of every vertex beyond it.

Step 3 is the whole correctness argument, and it is stronger than it looks:

> A triangle with `n·u = 0` lies in a plane that **contains** `u`. Translating
> any subset of its vertices along `u` leaves all three in that same plane. So
> the triangle stays planar, keeps its normal, and stays on the same swept
> surface. It is not approximately preserved — it is the same face, longer.

Triangles below the cut do not move; triangles above it translate rigidly;
triangles straddling it stretch inside their own plane. Nothing is split,
nothing is interpolated, the triangle count and triangle **order** are
identical, and vertices that were coincident stay coincident because the
shift is a pure function of the coordinate. Measured on every fixture:
triangle count, welded vertex count, unique edges, open edges, non-manifold
edges, odd edges, inconsistent winding, Euler characteristic, degenerate
triangles and self-intersecting pair counts are all **identical** before and
after (`tools/nso_extend_canonical_check.js`).

## Findings

### 1. The perpendicularity tolerance has to be relative, and here is the number

The ticket asked whether a fixed-tolerance checker could be reused naively
here. It cannot, and the measurement says so cleanly. One wall triangle,
exactly parallel to the axis in real arithmetic, read at four coordinate
magnitudes after a float32 round trip:

| placement | `\|n·u\|` | fixed 1e-6 gate | derived tolerance |
|---|---|---|---|
| at the origin | 3.380e-9 | pass | 5.532e-7 |
| offset +100 mm | 6.947e-8 | pass | 4.426e-6 |
| offset +1400 mm | **2.842e-6** | **FAIL** | 7.082e-5 |
| scaled ×75, offset +1400 | 3.789e-8 | pass | 1.888e-6 |

Same triangle, same shape, three orders of magnitude apart, purely from
float32 spacing. A fixed 1e-6 gate refuses a perfectly flat wall once the part
sits 1400 mm from the origin.

The tolerance is therefore derived per triangle from the numbers that triangle
is actually made of: `k · ulp32(magnitude) · maxEdge / (2·area)`, from the fact
that moving each vertex by `d` turns the unit normal by at most
`d·maxEdge/area`. `k = 4`. Two details matter:

- `n·u` is the 2D cross product of the two edges projected into the
  **cross-section** plane — it never touches an axis coordinate at all — so
  its error is driven by the cross-section coordinates only. The cap test
  `|n×u|` is driven by every coordinate. They get different `ulp32` inputs.
- A triangle so slivered that the bound exceeds `maxPerpTol` (1e-3) is marked
  **untrusted** rather than waved through on an enormous tolerance. An
  untrusted straddler makes a band unclean and refuses the whole operation.

The derived tolerance tops out at 7.08e-5 across everything measured, which is
~240× below the shallowest taper anyone drafts (1° is `|n·u| = 0.017`), so the
gate has a very wide separation between "flat wall" and "taper".

This is the same lesson `NSO_sculptWeldTol` and `NSO_weldEpsFor` learned about
weld distance, arriving from the other end: there, one sliver poisoned a
tolerance taken from the strict minimum; here, a fixed constant is either too
tight far from the origin or too loose near it. Neither is a number you can
pick once and write down.

### 2. Why the walls usually read *exactly* zero

Worth writing down because it looks too good to be true. For `u = X`,
`n·u = uy·vz − uz·vy`: it never reads an X coordinate. A wall triangle with any
edge exactly parallel to the axis — the usual quad split of an extrusion — has
a zero factor in **both** terms and reads exactly `0.000e+0` at any coordinate
magnitude, in any floating-point format. That is why `pin.stl`'s shaft, the
hinge barrel and `lid_strap` all report a worst `|n·u|` of exactly zero.

Finding 1's non-zero case is the one with **no** edge parallel to the axis —
three distinct collinear cross-section stations. Real tessellators produce
those (T-junction repairs, general polygon triangulation), so the relative
tolerance is not theoretical.

### 3. Length cannot be assumed, so it is probed

`fround(oldMax + delta)` is a step function of `delta`. Asking for 47.3 mm on a
piece whose far face sits at x = 1400 cannot give 47.3 mm, because the answer
is quantised to a 1.2e-4 mm grid. `NSO_extendRaw` therefore applies a delta,
**measures** what it actually got off the output buffer, corrects by the
measured error, and reports the residual it could not remove:

| ask | got | residual | in ULPs |
|---|---|---|---|
| 47.3 | 47.300048828 | −4.883e-5 mm | 0.400 |
| 31.415926 | 31.415893555 | +3.245e-5 mm | 0.266 |
| 60.000001 | 60.000000000 | +1.000e-6 mm | 0.008 |
| 25.5 | 25.500000000 | 0 | 0.000 |

The same 47.3 mm ask at the origin lands 7.629e-7 mm off — a thousand times
tighter, on identical code. So the **acceptance gate on length is counted in
float32 ULPs, not millimetres** (`lengthUlps`, default 2). A fixed millimetre
gate cannot pass both rows: 1e-6 mm refuses everything at 1400 mm, and 1.2e-4
mm is 160× sloppier than necessary at the origin.

The loop runs its full four attempts and keeps the best rather than stopping
early, because `err === 0` is not reachable for most asks.

### 4. `pin.stl` extends correctly — a chamfer is not a taper

The ticket named `pin.stl` as the refusal case. It is not one, and it should
not be. Measured, the gaps along X:

```
[0 .. 0.1]     worst |n·u| 7.05e-1     chamfer
[0.1 .. 19.9]  CLEAN                   the shaft, 19.8 mm
[19.9 .. 20]   worst |n·u| 7.05e-1     chamfer
```

`pin.stl` is a Ø3 × 20 mm cylinder with 0.1 mm chamfers at each end. The
chamfers are **end features**, not a taper along the axis, and they are 1.28%
of surface area sitting 9.9 mm from where the cut lands. Extending 20 → 32 mm
carries both of them along completely untouched — the X layers go
`0, 0.1, 19.9, 20` → `0, 0.1, 31.9, 32`, so both chamfers keep their exact
0.1 mm width — and the canonical checker reports the bore, the topology and
the self-intersection counts all unchanged. Refusing that would be refusing
correct work.

The honest tapered-piece refusal is a piece where the taper runs the length of
the axis, so there is no slab to insert into. The self-test builds one — a
truncated cone, Ø8 → Ø2.4 over 20 mm — and it refuses at 85.8% oblique area.
`fixture_blob_organic.stl` and `fixture_sphere_curved.stl` refuse at 100%.

The general rule this settles: **the gate belongs on the cut region, not on
the whole piece.** A piece only has to be a constant cross-section *where the
length is inserted*. Whatever the ends look like rides along.

### 5. Aspect ratio rises, and that is the shape of the answer

The one canonical-checker number that moves. A wall triangle stretched along
the axis keeps its cross-section width and gains length, so its aspect ratio
rises by construction:

| piece | slivers (aspect>100) | worst aspect |
|---|---|---|
| lid_strap 60 → 95 | 4 → 4 | 100.508 → 158.838 |
| hinge_knuckle_box 18 → 26 | 0 → 0 | 12.045 → 37.504 |
| pin 20 → 32 | **0 → 64** | 67.846 → 108.651 |

Measured but **not gated**, on purpose. `degenerate_tris` stays 0, area grows,
and — the part that matters downstream — the **shortest** edge in the mesh is
a cross-section edge, so it is untouched. `NSO_sculptWeldTol` and
`NSO_weldEpsFor` both key off short edges, so Extend moves edge lengths in the
safe direction for both of them.

### 6. `lid_strap` is one shell now, and the volume arithmetic had to follow

`fixtures/lid_strap.stl` is a 60 × 40 × 2.4 lid body plus a 60 × 10 × 0.6 strap
along one edge, overlapping in y 38..40. Since fixtures commit `6e0182e` it is a
real **boolean union** — one closed shell, 28 triangles, 16 welded vertices,
Euler 2 — so the overlap is counted once and the implied cross-section is
`40×2.4 + 10×0.6 − 2×0.6 = 100.8 mm²`. Measured: 6048.000 → 9576.000 mm³ over a
35 mm stretch = 100.8000 mm² exactly.

Worth recording because Extend was written against the *previous* version of
this fixture, which was two independent overlapping shells (24 triangles,
Euler 4, 25 piercing and 7 coplanar self-intersection pairs from the overlap).
There the signed volume of the soup is the sum over shells, the overlap is
double-counted, and the correct figure was 102 mm². Both test files asserted
102 and both were right at the time; the merge onto `claude-wip` caught the
change as a failing assertion rather than letting it slide.

Two things this does **not** change. Extend never cared: it translates the far
half of whatever shells are present, and on the old fixture both straddled the
cut at x = 30. And the bit-for-bit promise is unaffected either way — the
cross-section gate compares coordinates, not volumes. If that assertion ever
reads 102 again, the fixture has been reverted to the non-CSG version, not the
code broken.

## Refusals, each by its own name

| what | message |
|---|---|
| organic / curved | `no dominant straight axis - best is x with 100.0% of surface area oblique (limit 50%); this piece is curved or tapered on every axis` |
| tapered (cone) | same, at 85.8% |
| ambiguous (20 mm cube) | `no single dominant axis - 3 axes (x, y, z) are equally straight and within 1% of the same length; pass opts.axis to say which one you meant` |
| off-cardinal | `dominant axis is off-cardinal by 30.00 deg - Extend holds the cross-section bit-for-bit only on X, Y or Z; rotate the piece onto an axis first` |
| shortening | `Extend lengthens only - asked for 10.0000 mm along x but the piece is already 20.0000 mm; shortening would have to remove material and is out of scope` |
| no clean band | `no constant cross-section band along x - N gap(s) examined, none clean; widest (W mm) failed because ...` |
| painted | `Extend stood down - N painted face(s); the cut plane moves every face on one side of it. Clear paint to extend.` |

The off-cardinal refusal is a deliberate choice, not a gap. Translating by
`delta·u` with an oblique `u` writes all three coordinates, and the
cross-section then survives only to within a rounding error instead of bit for
bit. That is a different promise from the one at the top of this file, so it
gets a different mode rather than a quiet downgrade. The diagnosis comes from
the least eigenvector of the area-weighted normal covariance — the best
straight direction over the **continuum**, not just among the three — so a
straight-but-rotated piece is told it is rotated rather than told it is curved.

## PAINT SCOPE: WHOLE-PIECE

Per the scoping rule in `docs/HANDOFF.md`: the question is whether the feature
acts on an identifiable sub-region. It does not. The cut plane splits the piece
in two and translates one half, so every face on the moving side changes
position and every side wall the cut passes through changes extent. There is no
face Extend can promise to leave exactly where it was, which is precisely the
promise the paint rule demands. So **any** paint anywhere on the piece stands
the whole bake down, naming the count. `nsoMaskCount(m) > 0` is the whole test.

## Out of scope for this ticket, named

1. **Tapered pieces where the taper is functional.** No slab to insert length
   into. Refused (finding 4 draws the line in the right place).
2. **Organic / curved-axis geometry.** Refused.
3. **Re-tiling a repeating pattern.** Extend inserts length; it does not add or
   renumber features. Stretching `hinge_knuckle_box` makes **one** 3.6 mm
   finger longer rather than adding fingers — geometrically exact, and it will
   no longer interleave with its lid. Stretching a textured skin patch
   stretches the border cells rather than laying down more. Both are correct
   for what Extend promises and wrong for what a re-tiling tool would promise.
   "Stretch the border, re-tile the interior" is a separate, later ticket and
   must not be bolted on here.
4. **Shortening.** Every gate is written for `delta > 0`. Removing length can
   drive the cut past a feature at the far end and eat it, and nothing here
   would notice.
5. **Off-cardinal axes.** See above.

## What the UI is not, yet

A length box and a button, and that is deliberately the whole of it. Leave the
box blank and the first click reports what the piece actually is — detected
axis and current length — and fills the box with it, so the user edits a real
number instead of guessing one.

The full "click the leg → click the attachment point → auto-computed gap →
confirm" flow is orchestration: a picker, a hit-test, a preview, and a chain
into Seat-against-curved and washer placement. None of it can be trusted until
the primitive underneath is proven in isolation, which is what this ticket was
for. The primitive it will call is already here and already exercised by the
self-test: `NSO_extendLengthToReach(soup, axisIdx, targetCoord)` turns a picked
coordinate into the number the box holds, and returns the gap as well. Nothing
else in `app-extend.js` knows a UI exists. Build the chain in its own ticket.

## Against Scale-to-size (`app-scale.js`) — convergent, and where they differ

Extend was built on a branch point that predated `app-scale.js` landing on
`claude-wip`, so its design was derived from measurement rather than from
Scale's. Comparing the two after the merge is therefore worth something: they
agree where it counts, independently.

**The probe loop is the same shape.** `NSO_scaleSolve` applies a factor,
measures the span it actually got back off the scaled soup, corrects
(`f = f * (target / got)`), keeps the best of at most 4 passes. `NSO_extendRaw`
applies a delta, measures the extent it actually got, corrects
(`delta = delta + err`), keeps the best of at most 4. Neither trusts the
arithmetic; both re-measure the output. Same conclusion, reached twice.

**The relative-tolerance lesson is the same, at a different lever.**
`NSO_scaleGate` measures the after-mesh at `WELD_Q / factor` and
`AREA_EPS * factor²` rather than at fixed values, and says why in its own
comment: *"neither shows up in a fixed-grid comparison, which is the trap this
avoids."* That is the ticket's question answered for Scale's axis. Extend hits
the identical trap from the other side — its factor is always exactly 1, so
nothing moves with scale, but everything moves with the **coordinate
magnitude**, because float32 spacing is 1.9e-6 mm at 20 mm and 1.2e-4 mm at
1500 mm. Scale's tolerances track the factor; Extend's track the magnitude.
Both are the same rule: never compare on a grid the geometry does not live on.

**One real difference, and it is about role, not correctness.** Scale's
`NSO_SCALE_TOL_MM` is a fixed 1e-6 mm, and that is fine there because it is a
convergence *stop*, not an acceptance gate — the loop keeps the best result
whatever happens, so on a piece far from the origin (where 1e-6 mm is below one
ULP and unreachable) it simply spends all four passes and returns the closest
representable answer. Extend's equivalent figure is an acceptance *gate*: it
decides whether to hand the piece back or refuse. A fixed millimetre gate there
would refuse correct work on any part not near the origin, which is why
`lengthUlps` is counted in ULPs instead. If Scale ever grows an acceptance gate
on its measured span, it needs the same treatment.

**Not shared, and should not be.** Scale is a uniform bijection on coordinates,
so its gate can reason from "topology cannot change in exact arithmetic, only
float32 collapse can break it". Extend is not uniform — it moves one coordinate
of a subset of vertices — so it cannot borrow that argument and instead proves
its promise directly, by comparing every non-axis coordinate against the input.

## Reused from the sculpt tier, not re-implemented

Audited before anything was written, and this is what actually carried over:

- **`NSO_sculptCommitRaw`** — used verbatim through a one-line
  `NSO_extendCommit` wrapper. Undo entry first, display geometry rebuilt from
  the new `rawTris`, placed instance re-seated. The undo *type* is its own
  string (`extendReplace`) so the status line names Extend and not Smooth.
- **`NSO_buildAdjacency` / `NSO_sculptMetrics`** — the before/after topology
  evidence, guarded on `typeof` so the file still runs where they are absent.
- **The refusal contract** — `ok` false, `reason` set, `tris` is the original
  object, so callers swap unconditionally.
- **The paint stand-down shape** — same structure as Smooth's, with its own
  wording and its own row in the HANDOFF roster.
- **The "measure, do not assume" discipline**, which is the part that actually
  mattered. Every gate in `NSO_extendRaw` reads the output buffer rather than
  trusting that the loop did what it says.

One thing had to change outside these files: `app-core.js`'s undo dispatcher
did not know `extendReplace`, so undo reverted the geometry while the status
line said `Undo: unknown action`. Caught by the wire test, not by reading. The
nested-ternary status chain there is now a small lookup table with one row per
bake, so the next bake adds a row instead of an eighth level of nesting.

Not reused: nothing from the smoothing itself. Extend touches no adjacency
graph, runs no iteration, and moves no vertex off its own swept surface.
