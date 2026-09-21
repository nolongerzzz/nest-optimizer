# Wall thickness and nozzle safety

One canonical answer to "is this feature thick enough to print?", in
`nso_thickness.js`, callable from the app and from Node.

## Why this exists

"Is this thick enough to print?" was being answered separately everywhere it
was asked — and in most of those places it was not really being answered at
all. The audit that opened this ticket found this:

| where | what it actually did | floor? |
|---|---|---|
| `tools/mesh_validate.py` `wall_thickness()` | a real 3D raycast against the whole mesh, stated floor of 0.42 mm, genuine pass/fail | **yes** |
| `app-cut.js` `rawLocalThickness2()` | 2D bisector ray + nearest point on the cut cross-section; returned a bare `4` when it found nothing | no |
| `app-cut.js` `rawCornerWallLimit2()` | the same measurement, different skip rule, different meaning for the `4` | no |
| `app-cut.js` `wallLimitAt` (inline) | a third verbatim copy of `rawCornerWallLimit2` | no |
| `app-finish.js` `wallLimitAt` ×3 | three more verbatim copies, in `rawPerimeterFilletInPlace`, `rawVertexBallOnly`, `rawVertexBallCorners` | no |
| `nso_skin.js` `rib: 0.42` | a **default** in the pattern table, not a guard — `withDefaults()` passes `rib: 0.1` straight through | no |
| `app-cut.js` `localThickness()` | a seventh variant, inside the never-called `filletLoop` | no |
| `app-join.js` / `app.js` `buildCutVolume()` | rays along the **punch axis only**, reserves `minWall` there, then inflates the cut box laterally with no wall test at all | one axis only |

The last row was **missed by the first pass of this audit** and found later by
the local-carve audit. It is a different shape of gap from the others: it does
have a floor, but only along one of three axes, and at a corner two faces are
load-bearing. See *The corner case* below.

Three things the ticket expected to find did not exist:

- **There is no fin generator, and no nozzle-safety auto-bump anywhere in this
  repo.** Nothing raises a too-thin feature up to a printable floor. The 0.42
  in `nso_skin.js` is a stated default that any caller can undercut silently.
- **The fillet clamp never had a printability floor.** Its `* 0.45` is a
  geometric rule about how much of a wall a fillet may eat; it was never
  compared against a nozzle at all.
- **Nothing asked what a cut leaves standing on more than one axis.**
  `buildCutVolume` reserves `minWall` along the punch direction and assumes the
  other two.

So before this module the only real thickness check in the codebase was in
Python, reachable only through a validator CLI, and nothing in the app could
call it.

### The `4` was worse than a magic number

Both app-cut variants fell back to `4` when their probe found nothing, but they
meant **different things by it**:

```js
// rawLocalThickness2 — BAND
return Math.min(minD === 1e9 ? 4 : minD, nearestPt === 1e9 ? 4 : nearestPt);
// rawCornerWallLimit2 — CORNER
return best === Infinity ? 4 : best;
```

BAND folds the `4` into the `min`, so it is a **cap**: whenever the bisector ray
misses, BAND can never report more than 4 mm of wall however much is really
there. CORNER accumulates both passes into one running minimum and only falls
back when neither found anything. Two functions eleven hundred lines apart, the
same literal, two different meanings — and every caller read both as "4 mm of
wall is available".

Both meanings are preserved exactly (`fallbackMode: 'perSignal'` and
`'whenNone'`), so no geometry moved. What is new is `.measured`, which finally
lets a caller tell a measured 4 mm from a guessed one.

## What "thickness" means here

Distance from a surface to the nearest surface **behind** it, along the inward
normal.

- On a shell with two coherent sides, that is the wall thickness.
- On two sheets facing each other, it is the gap — which matters for the same
  reason, because an FDM printer fuses a sub-line-width gap into one solid.
- On a woven sheet it is the crossing clearance.

A face that meets nothing within the probe distance (default 5 mm) is a
**sheet**: a vase-mode wall whose width the slicer decides, or simply a wall
thicker than the probe. Sheets are counted, never failed — we do not know their
thickness, and inventing one is exactly what the old `4` was doing.

## The floor

`floorFor(nozzle)` = `nozzle × 1.05`, which gives **0.42 mm at a 0.4 mm
nozzle** — the figure `nso_skin.js` already quotes for its thinnest rib
("thinner and the slicer drops the rib") and the default `mesh_validate.py`
already gates on. It is a stated default, not a measured one; a caller who
knows their slicer's real line width passes `minWall` directly.

A wall built *at* the floor passes: float32 coordinates put a 0.42 mm rib at
0.419998, which is the file's rounding and not a thin wall. One weld radius
(1e-4 mm) of slack, the same figure used everywhere else in the repo.

## API

```js
NSO_Thickness.floorFor(nozzle)                     // mm
NSO_Thickness.measureMesh(rawTris, opts)           // 3D probe, whole mesh
NSO_Thickness.measureRegion(rawTris, faces, opts)  // 3D probe, a face subset
NSO_Thickness.cutClearance(rawTris, cutLo, cutHi, opts)  // what a PROPOSED cut leaves
NSO_Thickness.loopWallAt(loop2, i, opts)           // 2D probe, one point
NSO_Thickness.cornerWall(loop2, i)                 // 2D probe, CORNER preset
NSO_Thickness.bandWall(loop2, i)                   // 2D probe, BAND preset
NSO_Thickness.measureLoop(loop2, opts)             // 2D probe, whole section
NSO_Thickness.safeRadius(requestedR, availableMM, opts)
NSO_Thickness.describe(report)                     // one status line

// the LIVE probe — build once, ask many (added with Hollow / the stroke gate)
NSO_Thickness.prepare(rawTris, opts)               // -> a probe, or null
NSO_Thickness.strokeRefusal(gate)                  // the one wording for a refusal
```

### The live probe

Everything above answers a question about a mesh **once**: hand it a soup, get a
report. That shape is right for a batch check and wrong for a live one, and the
difference is not style — it is the weld and the grid. Every 3D entry point
starts with `indexSoup()` (a welded rebuild of the whole soup, a 27-cell
neighbour scan per vertex) and `buildGrid()` (a bbox hash of every triangle). On
a piece of any size that *is* the cost, and it is paid again on every call.
Asking `measureMesh()` per `pointermove` would re-weld a hundred-thousand-
triangle piece sixty times a second.

`prepare()` pays both once and hands back an object whose queries are a DDA walk
and nothing else:

```js
const P = NSO_Thickness.prepare(rawTris, { nozzle: 0.4 });

P.nearest(point, maxDist)       // { face, point, dist } — closest point on the surface
P.wallAt(point, { normal, probe })   // the wall thickness AT a point
P.hitsAlong(orig, dir, maxT)    // every crossing, sorted, coincident hits merged
P.inside(point)                 // parity — is this point in material?
P.strokeGate({ point, normal, depth, label })   // what a cut of `depth` LEAVES
```

This is **not a second opinion**. The ray code, the vertex-sharing exclusion
rule and the threshold resolution are the same ones `measureMesh()` uses, with
the setup hoisted out — `tools/nso_live_gate_test.js` part 1 compares the two
face for face on `fixtures/box_open.stl` and gets exact agreement on all 68.

`strokeGate` returns `{ ok, wall_mm, residual_mm, threshold_mm, measured, sheet,
reason }`. It **refuses**, where `cutWarning` only warns, and the two cover
different failures — see `docs/HOLLOW.md` §3. Unmeasured is not a pass in
disguise here either: the probe is widened to `depth + floor + 1 mm` before the
question is asked, so "nothing behind it" is a measurement about a wall deeper
than the stroke needs rather than a shrug.

The measuring calls all return the same shape. `cutClearance` is the odd one
out — a cut is a question about several axes at once, so its report is a list of
sides plus `severed` / `breached` / `thin`; see *The corner case* below.

```js
{
  kind, nozzle_mm, threshold_mm, probe_mm,
  measured, thin, sheets,   // counts
  min_mm,                   // thinnest measured; null if nothing was measured
  pass,                     // false only when something MEASURED came in thin
  examples: [{ at, hit, mm }],
  reason                    // human-readable, always set
}
```

`pass` is true when nothing measured came in under the floor. Unmeasured is
never a pass in disguise: `measured` and `sheets` say how much of the piece the
verdict actually covers.

`opts.faces` restricts which faces are **measured**; the whole mesh always stays
available as a **target**, because the wall behind a selected face is usually
made of faces outside the selection.

### The 3D probe

A port of `mesh_validate.py`'s `wall_thickness()`, not a reimplementation:
Möller–Trumbore against a uniform hash of triangle bounding boxes, walked cell
by cell along the ray (3D DDA) and abandoned as soon as the next cell starts
beyond the closest hit so far. The source triangle and anything sharing a
welded vertex with it are ignored.

The input is **radius-welded** first, at 1e-4 mm, exactly as the Python does —
hash into tol-sized cells, then search the 27-cell neighbourhood and take the
first vertex within a true radius. This is not a detail:

> The first version of this port welded only for *adjacency* and measured the
> raw positions. It agreed with the Python to 17 digits on all four
> `fixtures/open/` meshes — and disagreed on the first real production mesh it
> was pointed at (`tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 32,862
> triangles): **0.163 mm vs 0.239 mm**, 32,862 faces measured vs 32,565. The
> clean fixtures have no near-duplicate vertices, so a grid snap and a radius
> weld are identical on them and the bug was invisible. The tape mesh has
> hundreds of vertex pairs inside tolerance; welding collapses 297 faces to
> degenerate, which are then correctly not measured.

That mesh is now in the suite for exactly this reason. A checker that is only
ever tested on geometry built to be clean is not tested.

`tools/nso_wall_thickness_test.js` runs both implementations on the same
fixtures — including the 33k one — and requires exact agreement, so the two
cannot drift apart.

## The corner case: what a cut leaves standing

`measureMesh()` answers "is the wall that is there thick enough?". There is a
second question it **cannot** answer, and the local-carve audit found it:

> On `fixtures/box_open.stl` (60 × 40 × 25, 2 mm walls) a 4 × 2 × 6 bit sits in
> the corner of the `y = 0` wall and punches `+X`. It removes **48 of 48 mm³** —
> every cubic millimetre it asks for is solid. The one-axis `minWall` check rays
> along the punch axis, finds **60 mm** of material (it is travelling *along*
> the wall, not across it), reserves `minWall` and approves a 59 mm cut. That
> cut takes the entire 2 mm wall out over its window and opens the outside
> straight into the cavity.
>
> Afterwards the mesh is closed, single-component, genus 1, sound — and its
> thinnest wall is **1 mm**. `measureMesh()` passes it, *correctly*.

That is the crux: **severing a wall removes material, it does not thin it.** No
thickness check on the finished mesh can see this, however good it is. It has
to be caught before the cut, against both load-bearing faces.

`cutClearance(soup, cutLo, cutHi, opts)` does that. For each axis it samples
lines through the cut's cross-section, finds the **solid spans** along that
line in the original mesh, and asks what the cut leaves of each span it touches:

| verdict | meaning |
|---|---|
| `severed` | the cut swallows a solid span **whole** — nothing on that axis holds the member together any more |
| `thin` | material remains but under the floor |
| `breached` | the cut reaches open air on that side. Informational: the entry face of *every* cut breaches, because the bit has to come from somewhere |

`opts.through` names the axis the bit punches along. Severing *that* axis is
what a through hole **is**, so it is reported and not failed; severing any other
is a cut wall. `min_mm` is the thinnest wall *left standing*, so a breached side
contributes no `0` to it.

Working from spans rather than from the cut's faces matters: an earlier version
tested the material just outside each cut face, and silently missed severance
whenever the cut *overshot* the wall instead of sitting flush with it. The span
form catches both, and the suite tests the overshooting case explicitly.

One artefact worth knowing about, because it produced a false positive on real
geometry: a ray passing exactly through the diagonal two triangles of a quad
share crosses the surface once but records **two** hits at the same distance.
That breaks parity and yields a zero-thickness "solid span" that reads as a
severed member — on `box_open.stl` it made a legitimate corner notch look like a
cut-through. `allHits()` now collapses hits closer together than the weld
tolerance, and zero-thickness spans are skipped.

### Limits, stated

It samples `opts.samples`² lines per axis (5×5 by default, inset from the cut's
rim), so a wall threatened only between sample lines can still be missed. It is
a strictly denser probe than the five points `buildCutVolume` takes — not a
proof. Raise `samples` for a finer sweep; the suite checks that the audit case
reaches the same verdict at 11×11, so the result is not a sampling accident.

It reads the mesh as it is *before* the cut and assumes the cut volume is the
axis-aligned box it is given. A rotated bit should be passed the world AABB of
its cut volume, which is conservative: it can over-report, never under-report.
Sample lines whose hit list comes back odd are counted in `grazed` and
contribute nothing, so "nothing severed" can be told apart from "nothing could
be measured".

### What this does and does not change

`cutClearance` is a new capability, not a retrofit. It is now **wired to the
live cut path** — `app-join.js`'s `cutClearanceFor`, called from
`subtractSoupBFromA`, so both consumers of that core (Join / Subtract and
Local-Carve) get the same measurement from the same place.

It is wired as a **warning, never a refusal**, and that was the product
decision the first version deferred. Refusing would have been wrong rather
than merely strict: the case this utility was built to catch — the audit's
corner bite on `fixtures/box_open.stl` — is *exactly* what Local-Carve's corner
gouge does on purpose. A check that blocked it would block the feature it was
written for. So the cut runs, the finding rides the status line, and the user
decides.

`buildCutVolume`'s own one-axis `minWall` reservation is **unchanged**: it
still decides what gets cut, and `cutClearance` still only describes it. The
two answer different questions and use different floors — `minWall` is a 1.0 mm
stand-off for the safety box, the clearance floor is `floorFor(nozzle)`, what
the slicer can actually print.

## Consumers

| consumer | calls | status |
|---|---|---|
| `app-cut.js` `rawLocalThickness2` | `bandWall` | retrofitted |
| `app-cut.js` `rawCornerWallLimit2` | `cornerWall` | retrofitted |
| `app-cut.js` `rawEdgeRoundInPlace` | `cornerWall` + `safeRadius` | retrofitted, **and reports the floor** |
| `app-finish.js` `rawPerimeterFilletInPlace` | `cornerWall` | retrofitted |
| `app-finish.js` `rawVertexBallOnly` | `cornerWall` | retrofitted |
| `app-finish.js` `rawVertexBallCorners` | `cornerWall` | retrofitted |
| `app-cut.js` `localThickness` | — | dead code (`filletLoop` is never called); left alone, marked do-not-copy |
| `tools/mesh_validate.py` | — | unchanged; it is the reference the JS port is checked against |
| `app-join.js` `subtractSoupBFromA` (Join / Subtract) | `cutClearance` | **wired**, as a non-blocking status-line warning |
| `app-carve.js` `carveAt` (Local-Carve) | `cutClearance` | **wired** via the same core; same warning on the carve's own status line |
| `app-join.js` / `app.js` `buildCutVolume` | — | unchanged by design; it still decides what gets cut (see above) |
| `app-carve.js` `carveAt` (Local-Carve) | `prepare` + `strokeGate` | **wired**, and this one **refuses**, before the kernel loads |
| `app-brush.js` (Freehand Brush) | `prepare` + `strokeGate` | **wired**, three times: first dab, every dab, and the result at pointerup |
| `nso_hollow.js` (Hollow / Fill) | `floorFor`, `prepare`, `measureRegion` | **wired**; the floor and every ray it casts come from here |
| `nso_skin.js` | — | **not yet**; see below |

### What the retrofit did and did not change

It did **not** change any geometry. The presets reproduce each site's
historical number bit for bit, including both meanings of the `4`, and
`tools/nso_wall_thickness_test.js` proves it two ways: a 5446-measurement
differential against the pre-retrofit bodies pulled from git, and an A/B that
loads the fillet engines twice — once from the branch base, once from the
working tree — drives them over three shapes × five radii × three engines, and
requires the output to match float for float. (The base, not `HEAD`: once the
retrofit is committed, `HEAD` carries the delegation and the comparison would be
self-referential. The suite refuses to run it unless the source it pulled really
does contain the old inline body.)

What it added is `rawEdgeRoundInPlace.lastBuild.wall`:

```js
wall: {
  nozzle_mm, floor_mm,
  thin: [{ at, wall, leaves }],  // corners where the fillet leaves a sub-floor wall
  unmeasured,                    // corners running on the legacy 4 mm fallback
  pass
}
```

These are corners this engine has always been willing to cut and has never
until now reported. Nothing acts on it yet — surfacing it is deliberately a
separate step from changing what gets cut.

## Still open

- **`cutClearance` reports; it does not enforce.** Wired (above) as a warning
  on the cut's status line. Making it *refuse* is deliberately NOT done and
  should stay undone until a cut path exists that can offer the user a choice:
  the audit's corner carve is a legitimate cut, so a blanket refusal would
  remove a feature rather than add a guard. What is missing is a way to say
  "this severs a wall — continue?", not a stricter check. `strokeGate` does
  refuse, and that is not a change of mind about this one: it asks a different
  question (what the cut *leaves* at the point, not whether it *severs* a
  member) and the corner gouge passes it.
- **The probe samples, it does not prove.** 5x5 lines per axis on the cut's
  AABB (`tools/nso_cut_clearance_wire_test.js` re-runs the known case at 11x11
  to show the verdict is not a sampling accident). A wall threatened only
  between sample lines is still missed, and a rotated bit is measured through
  its world AABB, which over-reports rather than under-reports.
- **`nso_skin.js` has no guard.** `withDefaults()` accepts `rib: 0.1` silently.
  It should call `floorFor()` and either refuse or bump — the "auto-bump" the
  ticket assumed already existed. Not done here because it changes what gets
  built, which is a behaviour decision, not a consolidation.
- **Nothing acts on `lastBuild.wall` yet.** Enforcing the floor in the fillet
  clamp would change cut geometry on thin features; that is a product call.
- **`app.js`** (the pre-split monolith, not loaded by `index.html`) still
  carries its own copies. Left alone as dead weight.

## Running the checks

```sh
npm run wall:test          # the canonical checker + the retrofit's A/B proof
npm run wall:cut           # the cut-path wiring, driven through the real app
npm run live:gate          # the live probe, and the Carve / Brush stroke gate
npm run hollow             # Hollow and Fill, canonical checker before and after
npm run wire:hollow        # the Hollow / Fill buttons, driven through the real app
python3 tools/mesh_validate.py <file.stl> --non-solid   # the reference
```
