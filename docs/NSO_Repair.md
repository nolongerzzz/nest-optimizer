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

Exit 1 on drift, exit 2 when a fixture is absent. The numbers it asserts are
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
| pinch separation *(gated)* | splits a vertex where two or more sheets meet and nudges each copy back into its own shell |
| hole fill *(gated)* | fans a boundary loop shut, wound to match the shell |

Peeling is bounded: never more than 10% of the triangle budget, never more than
16 rounds. Hole fill refuses any loop longer than 64 edges — a loop that long
is missing geometry, not a hole, and fanning it is a guess.

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
  (`fixtures/repair/synth_pinch_2sheet_tight.stl`, 0 degrees: **0 -> 12**
  intersecting triangle pairs, so the gate blocks it and the file is returned
  untouched.)

Nothing local to the vertex separates the two cases. The fans look the same,
and how tight is too tight depends on the local clearance as well as the angle.
Counting self-intersections after the fact does separate them, which is why the
stage runs on a trial copy.

The same gate guards the final result: if the finished mesh has more
self-intersections or more odd edges than the input, the whole repair is
discarded and the input is returned.

## Known limits

### 37825 — self-touching single sheet: OUT OF SCOPE

Thingi10K 37825's defect is a single sheet touching itself, not two sheets
meeting. There is no second fan to separate, so vertex splitting has nothing to
work with. Fixing it needs local re-triangulation around the contact and
bridging the neck that the contact forms — a different operation with a
different failure surface.

**That is a separate future module, not a gap in this one.** The correct result
here is to decline, and declining is what the regression case asserts.

### 39644 — 3-sheet closed solid: correctly gated, not yet repaired

Thingi10K 39644 is a closed solid where three sheets meet. The pinch stage does
generalise to more than two fans, but the nudge direction for each fan is
derived from that fan alone, and with three fans the copies can be driven into
one another. The gate catches it and the file is left unchanged.

This is **correct behaviour, not a fix.** Making 39644 actually repairable needs
a nudge that solves for all fans together rather than one at a time, and that
work should not start without a dedicated 3-sheet closed-solid fixture to
develop against — the synthetic set here has no such case, and 39644 itself is
one sample, not a test.

### The three Thingi10K fixtures are not in the tree

They could not be fetched: outbound network in the build environment is
allowlisted and `thingiverse.com` is not on it (`403` on `CONNECT`; every mirror
tried was refused the same way). The three cases are wired into the runner but
have **never been run**, their expectations are transcribed from the ticket
rather than measured, and the runner labels them `PROVISIONAL` and exits
non-zero. See `fixtures/repair/thingi10k/README.md`.

The eight synthetic fixtures and the two repo meshes are the part of the suite
that is actually earned — every number there was measured against this code.

### Coplanar overlap is not counted as self-intersection

The triangle-triangle test deliberately returns false for the coplanar case.
Two coplanar triangles that overlap are a real defect, but counting them
reliably needs 2D polygon clipping, and a cheap test there produces false
positives on ordinary adjacent geometry — which, in a gate, means refusing to
repair meshes that are fine. The gate therefore under-reports on coplanar
overlap rather than over-reporting.

### T-junction search only looks at cracked topology

A T-junction is by definition a crack: the long edge is used once, and the two
short edges it should have been split into are used once each. So the search
only considers vertices and faces incident to an edge whose use count is not 2.

A vertex that merely happens to lie on an edge of a properly closed surface is
not a crack, and this module will not touch it. That is deliberate — splitting
there is meddling, and on the repo's own `box_closed.stl` and `hinge_pip.stl`
it used to fire 20 times on sound geometry. It is also what makes the stage
affordable: on a 33k-triangle mesh, scoping the search cut a full `commit()`
from 217 s to 2.7 s.

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

> The ticket that specified this module quoted "~5000 mm safe, degrades past
> ~10,000 mm". **Neither measurement above reproduces that**, and the figure is
> recorded here as unconfirmed rather than restated as fact. It may have come
> from a different criterion. The measured numbers are the ones the suite
> asserts. Either way the practical conclusion is unchanged: **the largest Bambu
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
5e-3 mm slivers up to a single 80 mm face — and at any grid pitch fine enough
for the slivers, one big triangle lands in tens of thousands of cells.

Measured on `fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 32,862
triangles: full `commit()` in 2.7 s, of which self-intersection counting is
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
