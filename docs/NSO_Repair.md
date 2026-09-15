# NSO_Repair — scope, limits and tolerances

Standalone non-manifold repair for triangle soup. Lives at `NSO_Repair.js` in
the repo root.

**Not wired into the app.** Nothing calls it — not Seal, not import, not
anything else. Wiring it in touches a protected subsystem and needs its own
review pass. This module is commit + regression suite + docs only.

```js
window.NSO_Repair.commit(rawTris, options) -> { rawTris, report, ok }
```

`rawTris` in and out is the app's raw soup: a flat `Float32Array` of 9 floats
per triangle. The returned array is a **new** `Float32Array` when a repair was
applied and the **caller's own array, same reference**, when it was not — so
"unchanged" is checkable by identity, not just by value.

`ok` is false only when the module could not run at all (bad input, internal
throw). A repair that ran and decided to change nothing is `ok: true` with
`report.applied === false`. Either way `result.rawTris` is safe to use.

## Running the regression suite

```sh
node tools/nso_repair_regress.js          # exit 0 = every number still matches
node tools/nso_repair_regress.js -v       # print every checked value
```

Exit 1 on drift, exit 2 when a fixture is absent. 22 cases, all measured
against this module. The numbers it asserts are
the contract. **If a change to this module moves one of them, that is the
change asking to be looked at, not the test asking to be updated.**

## What it repairs

Applied in this order. The first four are always safe and run unconditionally;
the last three are applied to a throwaway copy and kept only if the gate passes.

| stage | what it does |
|---|---|
| weld | merges vertices within `WELD_TOL`. Only *near* merges count as a repair; exactly-equal slots are just how a soup stores a shared corner |
| degenerate | drops zero-area triangles and triangles with a repeated corner |
| duplicate faces | drops repeated copies of a face, keeping the one whose winding agrees with the surrounding shell |
| flap peel | iteratively drops triangles with two or more edges that belong to nobody, then drops small open components sitting next to a closed shell |
| T-junction *(gated)* | splits a triangle whose edge interior carries another vertex, corner-to-point so no sliver is produced |
| pinch separation *(gated)* | splits a vertex where two or more sheets meet and nudges each copy back into its own shell. Covers both bowtie vertices and non-manifold edges |
| hole fill *(gated)* | fans a boundary loop shut, wound to match the shell — but only a loop that was in the input, never a seam this repair opened itself |

Peeling is bounded: never more than 10% of the triangle budget, never more than
16 rounds. Hole fill refuses any loop longer than 64 edges — a loop that long
is missing geometry, not a hole, and fanning it is a guess.

## Two kinds of pinch, one mechanism

A **bowtie vertex** is two sheets touching at a point and sharing no edge. A
**non-manifold edge** is three or more faces along one edge. Both surface as a
split vertex fan, so one stage handles both: the fan grouping joins two faces
only across a *manifold* edge. An edge used by three or more faces is the seam
where separate sheets coincide, not a connection, and treating it as one would
merge every sheet into a single fan and hide the defect.

Splitting every vertex along a non-manifold run separates the sheets coherently
— each sheet keeps its own copy of both endpoints, so the edge between those
copies ends up used by that sheet alone.

## Hole fill will not close a seam the repair opened

Pinch separation is the only stage that adds vertices, so a boundary loop
touching a vertex that did not exist in the input was opened by this repair, and
closing it would be bridging our own seam rather than filling a hole in the
model.

That distinction is the difference between repairing a mesh and reshaping it. A
sheet touching itself gets separated by the nudge and leaves a slit the width of
the nudge; capping that slit gives a watertight mesh with a neck whose width came
from `NUDGE_FRAC` rather than from the model. On 37825 that neck measures **0.1
mm** across — under any nozzle, and invented. Refusing leaves the slit open,
which the final odd-edge gate then sees, so the whole repair is discarded and
the file returned untouched.

## What `report.after` means

`after` always describes the mesh the caller actually receives. When the gate
rejects a repair the caller receives the **input**, so `after` equals `before`
and both deltas are zero. The measurements of the mesh that was thrown away go
to `report.rejected`, where they explain the refusal without ever being mistaken
for the result.

## Why the pinch stage is gated

A pinch vertex is one point where two otherwise separate sheets touch. The
repair gives each sheet its own copy of the vertex and nudges that copy back
into the shell it belongs to, so the sheets stop sharing a point.

Whether that is safe depends entirely on the **angle between the two sheets at
the shared vertex**:

- **Wide pinch.** Two cones meeting tip to tip. Each apex moves into its own
  cone, directly away from the other. Always safe.
  (`fixtures/repair/synth_pinch_2sheet_safe.stl`, 180 degrees.)

- **Tight pinch.** One sheet lying inside the cone the other sheet opens into —
  a spike standing in a pit, a fold closing onto itself. "Back into my own
  shell" points straight at the other sheet, because the other sheet is what is
  occupying that space. The fan walls sweep across it and the result
  self-intersects.
  (`fixtures/repair/synth_pinch_2sheet_tight.stl`, 0 degrees: **0 -> 4**
  intersecting triangle pairs, so the gate blocks it and the file is returned
  untouched. This read 0 -> 12 before the checker consolidation of 2026-09-15.
  The stage produces the same 12 candidate pairs it always did; 4 of them
  overlap by 6.275e-2 mm and are counted, and the other 8 have an interval
  overlap of exactly 0.0 -- they touch without penetrating -- and were counted
  by the old strict endpoint test. The outcome is unchanged.)

Nothing local to the vertex separates the two cases. The fans look the same,
and how tight is too tight depends on the local clearance as well as the angle.
Counting self-intersections after the fact does separate them, which is why the
stage runs on a trial copy.

The same gate guards the final result: if the finished mesh has more
self-intersections or more odd edges than the input, the whole repair is
discarded and the input is returned.

## Known limits

### 40921 — specified as a clean baseline; it is not one

Recorded here because the correction matters more than the case does.

40921 was specified as a clean, watertight no-op baseline, and the repo's own
`tools/stl_watertight_check.py` agrees: `OK`, 0 odd edges. That check counts
edges, and **an edge count cannot see a vertex pinch.**

The arithmetic settles it. Euler characteristic `V - E + F` is
`80 - 279 + 186 = -13`, and an odd characteristic is impossible for any closed
orientable surface. The file is two shells meeting at 17 bowtie vertices.
Splitting them gives `97 - 279 + 186 = 4` — exactly two spheres — and takes
self-intersections from 5 to 0.

So this is a repair case, not a no-op case, and the suite asserts the
characteristic on both sides so the argument is itself regression-gated. It also
asserts idempotency: a second pass must find nothing.

The cost is 0.19% of volume (9551.05 -> 9371.58), from nudging the 34 vertex
copies off the contact point. That is the price of separating the shells.

`fixtures/box-20mm.stl` is the actual no-op baseline in the suite.

### 37825 — self-touching single sheet: OUT OF SCOPE

One sheet touching itself along a single 4-use edge. Separating it opens a slit,
and the only way to close that slit is to bridge a neck at a width nobody
specified — 0.1 mm here, straight out of `NUDGE_FRAC`. Hole fill refuses (see
above), the slit stays open, and the odd-edge gate discards the repair: odd
edges would go 1 -> 4.

Bridging a neck properly means re-triangulating the neighbourhood at a chosen
width. **That is a separate future module, not a gap in this one.** Declining is
the correct result and the suite asserts it.

### 39644 — 3-sheet closed solid: correctly gated, not repaired

A closed solid with an internal partition wall attached along a 30x30 rectangle
of four 3-use edges. Separating the sheets detaches the wall, which takes one
solid to three, opens 8 odd edges and drops 7.1% of the volume. The gate
discards it and the file is returned untouched.

This is **correct behaviour, not a fix.** Repairing it properly means deciding
what an internal partition *is* — weld it into the shell, delete it, or keep it
and accept the non-manifold edge — and that decision is not one this module can
make from the geometry alone. It should not start without a dedicated 3-sheet
closed-solid fixture to develop against; 39644 is one sample, not a test.

> The original specification expected 39644 to be stopped by the
> **self-intersection** gate at 0 -> 9. It is stopped by the **odd-edge** gate
> instead, at 4 -> 8: detaching the wall opens boundary rather than crossing
> anything, so nothing ever self-intersects. The outcome the ticket asked for —
> gate blocks, file left unchanged — holds exactly. The 0 -> 9 figure is not
> reproduced and is recorded here as unconfirmed.

### Coplanar overlap is measured, but stays out of the gate

~~The triangle-triangle test deliberately returns false for the coplanar case.~~
**Superseded by the checker consolidation of 2026-09-15.** The objection was
that counting coplanar overlap reliably needs 2D polygon clipping, and that a
cheap test produces false positives on ordinary adjacent geometry — which, in a
gate, means refusing to repair meshes that are fine. `tools/mesh_validate.py`
had the real test all along: separating-axis in the plane with strict
separation, so triangles that merely share an edge or touch at a point have a
separating axis and correctly do **not** overlap. That is now the test here too,
and `analyze()` reports `selfIntersectionsCoplanar` alongside
`selfIntersections`.

The gate still counts **piercing only**, for the reason the original note gives
second: a boolean seam legitimately produces coplanar contact, so folding it in
would block repairs on sound meshes. The difference is that the under-report is
now a deliberate gate policy rather than a limitation of the test.

### T-junction search only looks at cracked topology

A T-junction is by definition a crack: the long edge is used once, and the two
short edges it should have been split into are used once each. So the search
only considers vertices and faces incident to an edge whose use count is not 2.

A vertex that merely happens to lie on an edge of a properly closed surface is
not a crack, and this module will not touch it. That is deliberate — splitting
there is meddling, and on the repo's own `box_closed.stl` and `hinge_pip.stl`
it used to fire 20 times on sound geometry. It is also what makes the stage
affordable: on a 33k-triangle mesh, scoping the search cut a full `commit()`
from 217 s to seconds (3.9 s today — see Performance).

## Tolerance budget

Both constants are absolute, in model units (mm), and exported on the module
(`NSO_Repair.WELD_TOL`, `NSO_Repair.SPLIT_EPS`). The numbers below are
**measured**, by the two tolerance cases in the regression suite, so they cannot
drift silently either.

### `WELD_TOL = 1e-4` — float32 scale boundary

A weld tolerance only does work while it is wider than the float32 spacing at
the coordinates in play. float32 spacing is not gradual: it doubles at every
power of two, so the boundary is a step, not a fade.

**Strict case** — a shared corner arrived at by two different code paths, each
copy landing one ulp off in opposite directions, so the two disagree by two
ulps. Measured:

| cube edge | \|coordinate\| | 1 ulp | 2 ulp | result |
|---|---|---|---|---|
| 20 mm | 10 | 9.54e-7 | 1.91e-6 | welds |
| 1000 mm | 500 | 3.05e-5 | 6.10e-5 | welds |
| 1020 mm | 510 | 3.05e-5 | 6.10e-5 | welds |
| **1024 mm** | **512** | **6.10e-5** | **1.22e-4** | **splits** |
| 2000 mm | 1000 | 6.10e-5 | 1.22e-4 | splits |
| 10000 mm | 5000 | 4.88e-4 | 9.77e-4 | splits |

The boundary is exactly the binade step at **|coordinate| = 512 mm**, i.e. a
part about **1024 mm across** centred on the origin. Past it, two ulps exceed
`WELD_TOL` and near-duplicates that should weld no longer do.

**Loaded case** — copies that agree bit for bit, which is what a mesh read from
an STL looks like. No tolerance is needed at all, and welding holds at every
scale tested, out to a 50,000 mm cube.

**Which one applies** depends on whether the mesh was loaded or computed. A file
straight off disk is the loaded case and has no scale limit worth worrying
about. Anything this app generates — cut, joined, softened — is the strict case,
and 512 mm is the number that matters.

> An earlier estimate of "~5000 mm safe, degrades past ~10,000 mm" circulated
> with this module. It does not reproduce under either criterion above and has
> been **withdrawn**; 512 mm is the measured boundary and the one the suite
> asserts. The practical conclusion is unchanged either way: **the largest Bambu
> build volume is 256 mm, an order of magnitude inside even the strict
> boundary**, so this is not a concern for this app.

### `SPLIT_EPS = 5e-3` — survives the float32 round-trip at every scale

Deliberately ~50x `WELD_TOL`. A T-junction is a topology error, not a precision
error, and the stray vertex can sit visibly off the edge it belongs on.

Measured: the T-junction fixture scaled to 20, 500, 5000 and 50,000 mm, pushed
through `Float32Array` at each scale, still produces exactly 1 split, still comes
out watertight, and still lands on an exact volume. **No scale limit found in
the tested range**, which matches the ticket.

## Performance

Self-intersection counting is the expensive part and it runs up to five times
per `commit()` (before, after, and once per gated stage that actually changed
something). The broadphase is a median-split AABB tree, not a uniform grid:
real meshes mix triangle sizes badly — the tape fixture in this repo runs from
7.5e-3 mm slivers up to a single 82.4 mm face, a spread of 1.09e4 — and at any
grid pitch fine enough for the slivers, one big triangle lands in tens of
thousands of cells.

Two corrections to that last clause, from the checker consolidation of
2026-09-15, because it was being quoted as a reason to prefer one checker's
*results* over another's:

- **The broad phase cannot change a count.** A tree and a hash are both
  conservative supersets feeding the same exact narrow-phase test, so the choice
  is performance only. This tree was checked against brute force on 6,000 tape
  triangles and missed 0 of 39,816 box-overlapping pairs; correctness rests on
  that, not on the structure.
- **"Tens of thousands of cells" does not describe the grid actually in use.**
  `tools/mesh_validate.py` sizes its cells by the *mean* triangle bounding-box
  diagonal (1.52 mm on the tape), not by the smallest feature, so the 82.4 mm
  face lands in 594 cells and the whole mesh costs 90,192 insertions for 32,862
  triangles — 2.7 per triangle. The argument holds against a grid pitched at the
  sliver scale; nobody pitched one there.

Measured on `fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 32,862
triangles: full `commit()` in 3.9 s, of which self-intersection counting is
about 260 ms per pass.

## Fail-safe contract

Every path out of `commit()` returns rather than throws, and returns the
caller's input untouched unless a repair both ran and passed the gate.
Asserted by the suite for: `null`, `undefined`, an empty soup, a soup whose
length is not a multiple of 9, a non-array, a `NaN` coordinate and an infinite
coordinate. A non-finite coordinate is refused up front — it is a broken input
rather than a topology defect, and every measurement downstream would quietly
produce `NaN`.

An internal throw is caught, reported as `ok: false` with the message in
`report.reason` and the stack in `report.error`, and the input is handed back.
