# Non-solid — a piece that is meant to be open

Per-piece flag, set by the user, never inferred. `m.nonSolid === true` on a
model object, read back through `nsoNonSolid(m)` (`app-nonsolid.js`), and
passed into the tools as `opts.nonSolid` (NSO_Repair), `--non-solid`
(`tools/mesh_validate.py`, `tools/stl_watertight_check.py`).

**What it means:** this piece is not meant to be a closed solid, so the checks
whose only job is to enforce "fully enclosed" stand aside for it. **What it does
not mean:** anything about self-intersection, degenerate triangles, non-manifold
edges or winding. Those catch real defects on any surface, closed or not, and
they run exactly as before. The flag is not a blanket bypass, and section 3
is written so it cannot drift into one; `tools/nso_open_flag_test.js` pins it.

Motivating cases: a TPU squishy or fidget printed as a single-wall shell that is
deliberately not enclosed (flex, weight); a "printable fabric" of woven strands
that are genuinely separate components by design; a vase-mode bracket or clip
that is one sheet.

## 1. Audit — where the pipeline gates on closure today

Every hit, from reading the code rather than grepping it. `app.js` is an
unloaded 9,934-line snapshot and is not listed; `app-*.js` is the loaded set.
"Delta" means before/after on the same piece, so a piece that arrives open
passes; "absolute" means zero required.

### Hard gates that act on an existing piece

| where | operation | test | kind | on failure | closure? |
|---|---|---|---|---|---|
| `NSO_Repair.js` `commit()` final gate | Seal ▸ Repair | `oddEdges` after > before (`odd = open + non-manifold`) | delta | whole repair discarded, input returned | yes |
| `NSO_Repair.js` `commit()` final gate | Seal ▸ Repair | piercing self-intersections after > before | delta | discarded | **no** — self-intersection |
| `NSO_Repair.js` `tryStage` | Seal ▸ Repair | per-stage self-intersection delta | delta | stage rolled back | **no** — self-intersection |
| `app-sculpt.js` `NSO_smoothGlobal` | Smooth | open/nm edges rose, degenerate rose, tri count changed | delta | refused | partly — plus degenerates |
| `app-sculpt.js` `NSO_smoothGlobal` | Smooth | signed volume flipped sign, or moved > 25 % | assumption | refused | **assumes** a solid: on an open shell the figure is noise. Measured on the cup, 20 hard passes: 94 % "volume loss" against 60 % surface-area loss, and 60 passes take the signed volume negative |
| `app-finish.js` `applySoftenOnFace` (4 wrap paths) | Soften | `nsoSealScore` open/nm rose | delta | "did not close — piece unchanged" | yes |
| `app-finish.js` `applyCapOnFace` | Cap | `rawCheckWatertightQuick` — odd > 208 or stacked > 208 | absolute, with 208 slack | "Cap failed" | yes, coarsely — and winding |
| `app-join.js` `completeJoin` | Join, final | both inputs scored closed AND result open | conditional delta | "would reopen the pieces" | yes, only armed on closed inputs |
| `app-join.js` route 0 (planar fuse) | Join | both inputs closed AND fused result open | conditional | silently falls through to routes 1/2 | yes |
| `app-join.js` route 2, `subtractSoupBFromA` | Join / Subtract | Manifold kernel refuses non-2-manifold input | absolute, delegated | "Not manifold" | yes — the kernel's, not ours |
| `nso_inside_corners.js` (not loaded by index.html) | pocket corners | plug bake `open \|\| nm \|\| stacked` | absolute | refused | yes, and winding — on a generated plug, correctly |

### Stages that silently *modify* an open-by-design piece

These are the actual hazard. None of them is a gate; each is a repair step
whose premise is "edges are meant to be paired", and each reduces the odd-edge
count, so the delta gate above rewards it and `commit()` reports success.

| where | what it does to an intentional opening |
|---|---|
| `NSO_Repair.js` `fillHoles` | fans any boundary loop of ≤ 64 edges shut. A cup rim, a clip edge, a vent |
| `NSO_Repair.js` `peelFlaps` | deletes any triangle with ≥ 2 unpaired edges, iteratively, up to 10 % of the soup. Eats sheet corners and strand ends |
| `NSO_Repair.js` `dropOrphanComponents` | deletes any open component ≤ max(4, 1 %) triangles if any closed component exists. A free strand next to a body is "debris" |
| `app-finish.js` plain Seal (`capSmallOpenLoops`, `capAllOuterHoles`, `repairJoinedSoup`) | its whole purpose is closing openings |

Measured on the fixtures (section 5): with no flag, Repair removes the 2 corner
triangles of the open clip and 20 strand-end triangles of the weave, and tries
to fan the cup's two rims shut (blocked only because the fan happened to
self-intersect). All three are reported as `applied: true`.

### Gates in the tools and CI

| where | test | kind |
|---|---|---|
| `tools/stl_watertight_check.py --odd` | any edge count ≠ 2 | absolute; the project acceptance rule (`docs/HANDOFF.md` "Pass/fail is math") |
| `tools/3mf-test/import-check.js`, `import-drive-check.mjs` | shell out to the above, must be `clean` | absolute, on closed fixtures |
| `tools/nso_wire_fuse_test.js` | fused result `open === 0 && nm === 0` | absolute, on closed fixtures |
| `tools/nso_skin_test.js`, `nso_seat_gap_test.js`, `nso_skin_drive_check.js` | `open_edges === 0`, Euler 2 / 4 | absolute; the skin is a relief on a closed block |
| `tools/nso_skin_patch_test.js`, `nso_skin_patch_drive_check.js` | every patch through `verdict()` **twice**, with and without the flag; both must pass | absolute, both ways - the point being that the flag is not what carries these files |
| `tools/mesh_validate.py` | reports numbers only (until this change: no verdict) | — |

### Assumptions (no check, result only meaningful closed)

Signed volume everywhere it is reported (`NSO_Repair.analyze`, Smooth's
budget, `tools/3mf-test` "wound outward", and Thicken's winding sign in
`app-finish.js` `_thickenOffsetSoup` - its in/out split itself is the convex
hull plus smooth-crease growth, which needs no closure); `nso_skin.js` takes
"a closed triangle soup" as a precondition and
never measures it, before or after. These are documented here and left as
they are: the flag does not make them correct, and none of them is a gate.

### What has no closure check at all

STL and 3MF import, library load, Split, Solidify and plain Seal (report
only), Thicken (deliberately: "slots are leftover open loops on purpose"),
every export path (STL, plate STL, 3MF), Optimize. **An open piece already
exports.** Nothing needed unblocking there, and the flag does not touch export.

Solidify has since gained a result gate, but it is not a closure check and
does not read the flag: it refuses (piece unchanged) any result with more
open, non-manifold or degenerate edges/faces than its input, measured by
`NSO_Repair.inspect`, and leaves a piece with no open edge untouched. See the
comment above `solidifySelectedModel()` in `app-finish.js`.

### Nozzle-safety guard: there isn't one

The word "nozzle" appears in two prose comments and one default. `nso_skin.js`
builds its thinnest rib at 0.42 mm "one extrusion line at a 0.4 nozzle" but
never checks a rib against it. The fillet clamp in `app-cut.js`
(`localThickness`, `rawLocalThickness2`, `rawCornerWallLimit2`) is a 2D ray cast
in the cut cross-section that limits a fillet radius to 30–45 % of the local
wall; it sees one planar slice, has a silent 4 mm fallback, and compares
against nothing printability-related. There was no fin/strut guard to reuse.
Section 4 is the first positive thin-feature check.

## 2. The flag

Follows mask6's paint exactly, because the same reasoning applies: a
deliberate, visible, user-set exception, never an automatic inference.

- **Set** with the *Non-solid* toggle in the Adjust card - its own purple
  button below Seal, apart from Repair's - on the selected piece only.
  Disabled with no selection. It is still a plain `<input type="checkbox">`
  (`#chk-non-solid`) under the button face, so `checked` / `disabled` are the
  state, exactly as before.
- **Also set by two bakes, and only two.** Both are constructions the user
  chose, both name the flag in their own status line, and neither measures
  anything off the mesh - which is what keeps them out of the inference the
  last bullet rules out. `nsoNonSolidSet` takes `opts.silent` for both, so the
  flag does not overwrite the line of the bake that set it. A new bake that
  sets the flag must meet the same bar.
  - Skin's **free layer** (added 2026-09-16; `app-skin.js`, the `Free`
    checkbox next to the layer-2 pattern) hands the piece back with a second,
    free-hanging shell - a sheet resting on the skin's tips - so the piece
    really does stop being one closed solid. See `docs/HANDOFF.md`, "Skin wrap
    + the double skin".
  - **Skin patch ▸ loose** (added 2026-09-17; `app-skin-patch.js`, the
    `bordered` / `loose` select) adds a standalone patch that is the pattern's
    features alone - a free-standing one-extrusion-line lattice, the
    printable-fabric case this file's motivating cases name. Worth being exact
    about, because it is not the free layer's reason: a loose patch is
    **closed** as built (0 open edges, 0 non-manifold, 0 piercing; it passes
    `--gate` and `--gate --non-solid` alike), so the flag is not what gets it
    through a check. What the flag does is stand down the stages in section 3
    that would quietly trim a lattice if it ever stopped being closed, and say
    to the next person that the openness would be intended. The `bordered`
    variant of the same bake does NOT set it: its rim closes and stiffens it,
    it is one shell by construction, and flagging it would only remove a check
    it passes. See `docs/HANDOFF.md`, "A skin pattern as its own printable
    object - the patch".
- **Visible** as a purple `non-solid` tag on the piece's row in the model
  list, as the checkbox state whenever that piece is selected, and in every
  status line a consumer writes (`Repair (non-solid) done - …`,
  `Smooth done (non-solid) - …`, `Seal stood down - … is flagged non-solid`).
- **Undoable** (`nonSolidReplace`), like paint. When a bake sets it, the
  BAKE's undo entry carries it: `pushUndo` (app-core.js) snapshots `nonSolid`
  the same way it snapshots the paint, so one Undo puts the geometry and the
  flag back together rather than leaving the flag on a piece that no longer
  has two shells.
- **Per object.** Not global, not per plate. `state.models[i].nonSolid`.
- **In-memory only**, like paint. It does not survive an export/import round
  trip and the 3MF writer does not carry it; the reader is geometry-only.
- **Never inferred.** `app-nonsolid.js` reads no edge count. The test asserts
  it. A mesh with 840 open edges and the flag off is an open mesh, and every
  check treats it as one.

The name is `nonSolid`, not `intentionallyOpen`, because "open" already means
three different things in this codebase (open edges, an open boundary loop,
`box_open.stl` which is topologically closed) and the property that matters
downstream is *there is no inside*: no volume, no hole to fill, no debris to
peel.

## 3. What still runs, what is skipped

The split, per consumer. Anything not listed does not read the flag and is
unchanged.

| consumer | STILL RUNS with the flag | SKIPPED with the flag |
|---|---|---|
| `NSO_Repair.commit(raw, {nonSolid})` | weld, degenerate strip, duplicate-face strip, T-junction split, pinch separation, **seam re-close** (below), **both final gates** (self-intersection delta, odd-edge delta), input validation, empty-mesh backstop | flap peel, orphan-component drop, hole fill — each recorded in `report.stages` as `skipped: 'nonSolid'` |
| Seal ▸ Repair (`app-finish.js`) | everything above; status line names any self-intersecting pairs that remain, so a defective piece never reads as a clean no-op | — |
| plain Seal (`app-finish.js`) | — | the whole operation stands down with a message: Seal only closes openings |
| Smooth (`app-sculpt.js`) | triangle count, open-edge delta, non-manifold delta, degenerate delta, paint stand-down | the signed-volume sign check and the 25 % volume budget, **replaced** by the same 25 % budget on surface area |
| `tools/mesh_validate.py --gate --non-solid` | non-manifold edges, inconsistent winding, degenerate triangles, piercing self-intersections, **plus** the wall/gap check (section 4) | the open-edge count |
| *Check piece* (`app-defects.js` / `nso-defects.js`) — the viewport overlay | every measurement above, flag or no flag: open edges are still counted and still drawn in red, they just stop being a failure. The wall/gap check runs at 0.42 mm either way, because the overlay is a viewer and not the gate | the open-edge count, **in the verdict only** |
| `tools/stl_watertight_check.py --odd --non-solid` | non-manifold edges (count > 2), `--degen` | open edges (count == 1) |

Not skipped anywhere: **self-intersection, degenerate triangles, non-manifold
edges, winding consistency.** `verdict()` in `mesh_validate.py` is written as
a list with one flag-conditional entry so the split is readable in one place.

### Skipping a closure stage never licenses opening the surface

Added 2026-09-17, after the flag was found to make `NSO_Repair` produce a
*worse* result than no flag at all on a real mesh — odd edges 0 → 15, and the
final gate then discarding 295 degenerate strips, 288 T-junction splits and a
56-pair drop in self-intersections along with them.

The three skipped stages were never the only ones that touch boundary. The
**degenerate strip opens the surface as a side effect of doing its job**: a
zero-area sliver is very often the stitch holding a coarse edge to the two
finer edges it was subdivided into, so deleting it unpairs all three. The
duplicate strip can take an edge's last second user the same way, and the
T-junction split cannot always rebuild the result — it refuses a stray vertex
closer to an endpoint than `SPLIT_EPS`, which on a 0.01 mm leftover edge means
every interior point of it. On a closed-intent piece hole fill mopped all of
that up at the end and it never showed. With the flag on there was nothing left
to mop it up, so the repair's own damage reached the gate and the gate — right,
on the evidence it had — threw the whole repair away.

So the rule the flag actually encodes is narrower than "closure stages stand
aside", and this is it:

> **A stage may undo damage this run did. No stage may close, peel or drop
> boundary the piece arrived with.**

`commit()` records the arrival boundary as a set of welded vertex pairs before
any stage runs, and `seam-reclose` fans shut only loops containing none of them.
An opening the piece came with is never one of those loops, so a rim, a clip
edge, a strand end and `synth_hole`'s missing triangle are all still left
exactly as the user left them. Its work is counted as `seamsReclosed` /
`seamTrisAdded`, never as `holesFilled`, so "the flag never fills a hole in the
model" stays literally true. Full mechanism, including how an arrival edge stays
recognisable through a T-junction split or a pinch rename, in
`docs/NSO_Repair.md`.

The same reasoning has not been needed anywhere else: no other consumer of the
flag deletes geometry. `tools/nso_open_flag_test.js` §2b and §2c pin it, on a
built fixture and on the real mesh it was found on.

Rule for new consumers, same as paint: state `NON-SOLID SCOPE` in your own
source next to the check, point at this file, read `nsoNonSolid(m)`, never
re-derive intent from an edge count. `tools/nso_open_flag_test.js` greps for
the label and fails without it.

## 4. The positive check for thin shells — wall / gap

An intentionally-open shell can still be checked on the dimension that matters
for it. `mesh_validate.py --min-wall X` (on by default at 0.42 mm under
`--non-solid`; `--min-wall 0` turns it off) casts a ray from every face's
centroid along the inward normal and reports the distance to the first surface
it meets within `--wall-probe` (5 mm), ignoring the face itself and anything
sharing a welded vertex with it.

- On a two-sided shell (the cup, a squishy) that is the **wall thickness**,
  face by face. Thinnest under the threshold → `FAIL wall/gap under …`.
- A face that meets nothing within the probe is a **sheet** — a single-surface
  vase-mode wall, whose width the slicer decides — and is counted, not failed.
- The ray does not ask which way the hit faces. Behind a real wall the nearest
  surface is always its far side, so a thin wall cannot be missed; what the
  test can additionally report is a thin **gap**: two sheets closer than a line
  width, which FDM fuses into one. On the weave that number is the crossing
  clearance, which matters for the same reason.
- A wall built exactly at the threshold passes: one weld radius (1e-4 mm) of
  slack absorbs float32 rounding, which puts a 0.42 mm rib at 0.419998.

The threshold is the only nozzle-derived number in the repo, the one
`nso_skin.js` states for its ribs. It is a default, not a measurement, and it
is a parameter. It is a validator check, not an app gate: nothing in the app
refuses a piece over it.

Since 2026-09-17 it also runs **in the browser**: `nso-defects.js` carries a
line-for-line transcription of `wall_thickness()` (same inward-normal ray, same
hash walked by 3D DDA, same welded-vertex skip, same weld-radius of slack), and
the *Check piece* button paints every face under the floor violet on the piece
itself. `tools/nso_defect_overlay_test.js` holds the transcription to
`mesh_validate.py` on every STL in the repo — thin and sheet counts, the
thinnest figure, and the example faces face for face — so the browser cannot
drift from the validator. Still not a gate: it draws and reports, and refuses
nothing.

## 5. Validation

Fixtures in `fixtures/open/` (generated by `tools/nso_open_make_fixtures.js`;
`--check` byte-diffs). Every number below is what `tools/mesh_validate.py
--gate --non-solid` prints today; `tools/nso_open_flag_test.js` asserts them.

| fixture | open edges | winding | degen | pierce | wall / gap | verdict with flag | verdict without |
|---|---|---|---|---|---|---|---|
| `open_clip` — U-channel, one sheet | 50 | 0 | 0 | 0 | sheet (200/200) | **PASS** | FAIL open edges |
| `open_clip_selfint` — fin through the floor | 54 | 0 | 0 | **4** | sheet | **FAIL** pierce | FAIL |
| `thin_shell_cup` — open top, 1.2 mm wall | 96 | 0 | 0 | 0 | 1.197 mm, 0 sheets | **PASS** | FAIL open edges |
| `thin_shell_cup_selfint` — fin through both walls | 100 | 0 | 0 | **7** | 1.197 mm | **FAIL** pierce | FAIL |
| `thin_shell_cup_thin` — one patch dented to 0.25 mm | 96 | 0 | 0 | 0 | **0.249 mm on 96 faces** | **FAIL** wall | FAIL |
| `fabric_weave` — 5×5 weave of separate ribbons | 840 | 0 | 0 | 0 | 1.203 mm crossing gap | **PASS** | FAIL open edges |
| `fabric_weave_selfint` — one weft through the warps | 840 | 0 | 0 | **52** | 0.03 mm | **FAIL** pierce | FAIL |
| `thin_shell_cup_cracked` — the cup, open on purpose *and* defective | 100 | **9** | **12** | **7** | 1.197 mm | **FAIL** nm+winding+degen+pierce | FAIL |
| `skin-samples/skin_crosshatch_A` — tonight's skin sample | 0 | 0 | 0 | 0 | 0.420 mm (the ribs, at threshold) | **PASS** | PASS |
| `skin_crosshatch_A` + injected fin | 4 | 0 | 0 | **24** | — | **FAIL** pierce | FAIL |
| `skin-patches/patch_crosshatch_loose` — the standalone lattice | 0 | 0 | 0 | 0 | 0.420 mm, 200 sheet faces | **PASS** | PASS |
| `skin-patches/patch_zigzag_loose` — ridges on two ties, 0.42 mm foot | 0 | 0 | 0 | 0 | 0.420 mm | **PASS** | PASS |
| `skin-patches/patch_ring_loose` — the tapered annulus alone | 0 | 0 | 0 | 0 | 0.566 mm | **PASS** | PASS |
| `skin-patches/patch_*_bordered` — the three washers | 0 | 0 | 0 | 0 | 0.420 / 0.600 / 0.566 mm | **PASS** | PASS |

And through `NSO_Repair.commit`, flag on: the three clean shapes come back
with open edges unchanged and no flap / orphan / hole work (the cup gets 32
near-duplicate ring vertices welded, which is the weld doing its job); the
three defective shapes report their piercing pairs before and after, with
nothing peeled away to make them disappear; the repo's own gated pinch case
still gates; `synth_hole.stl` flagged non-solid is left open (the user said
so), and unflagged is filled as before.

`thin_shell_cup_cracked` is the case for the rule in section 3, and the only
fixture here that is open by design *and* mostly repairable. It is the cup with
12 zero-area sliver stitches over T-junctions, 3 reversed duplicate faces and
the `_selfint` fin. Six of the stitches are cut at 4e-4 of their edge, inside
the margin the T-junction split will not work in, so deleting those slivers
leaves six three-edge cracks nothing downstream can re-stitch. Flag on,
measured:

| | before | after |
|---|---|---|
| open edges (2 rims + the fin) | 100 | **100** |
| boundary loops | 3 | **3** |
| non-manifold edges | 9 | **0** |
| degenerate triangles | 12 | 6 |
| piercing pairs | 7 | 7 |

with 12 degenerate stripped, 3 reversed duplicates dropped, 6 T-junctions
split, 6 seams re-closed, 0 holes filled, 0 triangles peeled, `applied: true`.
Before the fix the same call read odd 109 → 118 and returned the file
untouched. The remaining 6 degenerates are the zero-area fans that closed the 6
collinear cracks — the only closure a collinear crack has, and the same trade
the unflagged path has always made.

Without the flag this fixture declines, and for a reason that predates all of
this: hole fill is all-or-nothing, fanning the two rims shut self-intersects at
166 pairs, so the gate rolls the stage back including the six crack fills. It
is pinned as measured. It is also the point — an open piece wants the flag.

On the real mesh it was found on, `fixtures/tape_welded_clustered.stl` (32,860
triangles, 295 collinear sliver stitches, closed on arrival), flag on now lands
on the same mesh as flag off: odd 0, 7 degenerate triangles, piercing pairs
185 → 129, via 4 seams re-closed instead of 6 holes filled and 2 flaps peeled.
Before the fix: odd 0 → 15, everything discarded.

**About the skin samples.** All nine `fixtures/skin-samples/*.stl` are closed
shells: `_A` and `_B` read 0 open edges each, and `_block` is the two together
(their piercing/coplanar counts are the tips-touch-B interface, by design). The
skin module builds a relief *on* a closed block and asserts Euler 2 for it.
The "free-hanging strands" case is therefore not represented by any committed
skin fixture; `fabric_weave.stl` is the printable-fabric analog here, and the
crosshatch sample is validated as what it is — a closed part with 0.42 mm ribs
that the wall check reads exactly.

**About the skin patches** (`fixtures/skin-patches/`, 2026-09-17). All six are
closed too, and that is the finding rather than a footnote: a standalone
pattern *could* have been the open-by-design case, and it is not, because
giving the relief a host of its own is what makes it printable at all — the
relief taken bare is a zero-thickness open sheet (Euler 1, 196 open edges).
So the loose patches are flagged as a **declaration about intent**, not to
clear a check, and the table above shows them passing both columns. The one
figure worth carrying: without its 0.42 mm foot the loose zigzag's flank reads
**0.367 mm on 30 faces** and FAILS the wall/gap check while staying perfectly
closed — a case where section 4's positive check is the only one that sees the
defect, on a piece that is not open at all.

## 6. Not done, on purpose

- The flag is not persisted to 3MF. Same as paint; the reader is geometry-only.
- Thicken, Cap, Join and Subtract do not read the flag. Cap's and the
  kernel's closure dependence is an algorithmic assumption (cap loops, the
  kernel), not a check to skip, and skipping would not make them correct on
  a sheet. Thicken (since the 2026-09-16 rewrite, a per-face / per-vertex
  planar offset) never needed closure, so there is nothing for the flag to
  lift; open loops go through it untouched.
- ~~The wall/gap check lives in the validator, not in the app. Nothing in the
  browser measures thickness yet.~~ **Done, 2026-09-17.** `nso-defects.js` is
  the browser copy of `wall_thickness()`, held to this file's numbers on every
  fixture by `tools/nso_defect_overlay_test.js`, and the *Check piece* button
  paints the faces under the floor violet on the mesh. See
  `docs/DEFECT-OVERLAY.md`. It is still not an app GATE: nothing in the browser
  refuses a piece over it, exactly as section 4 says.
- `stl_watertight_check.py --non-solid` still rounds at 1e-5, with the known
  false-open-edge mode on large float32 parts (`docs/HANDOFF.md`). Use
  `mesh_validate.py` for a real verdict.
