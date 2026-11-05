# Local brush — freehand surface deformation

`app-brush.js`, wired into `index.html` at the current `?v=inside6` tag, plus
two small hunks in `app-core.js` (pointer arbitration and one undo label), one
additive accessor in `app-mask.js` (`nsoMaskPlaneList`), and two lines each in
`app-measure.js` / `app-center-lock.js` so the mutual-disarm protocol runs both
ways.

Checks:

```
npm run brush        node tools/nso_brush_test.js        headless geometry, 91 checks
npm run wire:brush   node tools/nso_wire_brush_test.js   real app, real pointer events, 56 checks
npm run paint:scope  node tools/nso_paint_scope_test.js  the roster label, 33 checks
```

All three are in `npm test`.

## Not Local-Carve

`app-carve.js` / `nso_carve.js` / `docs/LOCAL-CARVE.md` is a different tool and
this one does not replace, wrap or compete with it. The difference is not
cosmetic:

| | Local-Carve | Brush |
|---|---|---|
| operand | a **blade profile** (flat / ball / vee) with real dimensions | the surface under the cursor |
| placement | one click at a face, edge or corner, freely oriented | a drag; a dab every `0.25·radius` of travel |
| mechanism | builds a cut volume and runs it through the **CSG kernel** (`NSO_CSG`, `subtractSoupBFromA`) | moves the piece's own vertices; no boolean, no kernel |
| topology | the kernel retriangulates whatever it likes | conforming edge splits only, T-junction free by construction |
| result | an exact, dimensioned pocket | a freehand dish, groove or bump |

Reach for Local-Carve when the shape matters and you can name it. Reach for the
brush when the shape is a gesture. Neither is the other's fallback, and a bug in
one is not a bug in the other.

Three modes share one mechanism — Carve (in along the normal), Emboss (out
along the normal), Smooth (a Laplacian confined to the area under the brush).

## The audit that came first, and what it changed

The ticket asked whether anything in the app already did continuous
drag-to-paint with a live uncommitted preview. **Nothing did.** Every
paint / overlay / bake mechanism was single-click-and-done:

| mechanism | shape | commit |
|---|---|---|
| Face paint (`app-mask.js:544`) | one `pointerdown` → `nsoMaskToggleAt` | immediate, same event |
| Soften pick (`app-core.js`) | `state.softenArmed` → one click | immediate, disarms |
| Cap pick (`app-core.js`) | `state.capArmed` → one click | immediate, disarms |
| Join face pick (`app-core.js`) | one click per piece | immediate |
| Smooth (`app-sculpt.js`) | button → whole-piece bake | immediate |

Drag existed in three places and **none touched geometry**: `startMoveDrag`
(a placed piece's x/z — pose only), the cutter plane helper (the mesh is
untouched until Cut), and the yaw drag.

**Re-checked after the five-thread land (2026-09-18) and it still holds.**
Local-Carve, Measure, Delete painted, Texture and Center-lock all arrived in
the meantime and every one of them is a click tool — armed flag, one click,
immediate. `grep -n pointermove app-*.js` finds exactly three files: `app-core`
for the three drags above, `app-seat-grid` copying a pose onto a grid it
already built, and this one. There is still no other hover path and still no
other uncommitted-geometry display.

Three further gaps, each of which shaped this file:

- **No hover feedback anywhere.** `grep -rn hover` over `app-*.js` was empty.
  `onCanvasPointerMove` early-returns unless one of those three drags is
  already running, so there was no pointermove path that fires while nothing
  is pressed. The size ring needed one built from scratch.
- **`state.previewMesh` is not a preview** despite the name — it is the
  displayed mesh when there is no real plate pack (`previewModelOnPlate`).
  There was no uncommitted-geometry display path in the repo at all.
- **Undo is one entry per commit.** A stroke that committed per pointermove
  would push hundreds of entries.

`cth/pointer-capture.js` does tell a click from a drag, but only to *suppress*
the drag — its `onDrag()` discards the gesture. It is CTH harness plumbing,
not app interaction.

So the stroke session is modelled on `startMoveDrag` / `dragMovePlaced` /
`endMoveDrag` — the only accumulate-then-commit-once shape in the repo — and
everything else is new.

## The base rule

Every stamp is applied to the **undeformed base**, never to the running
result. A stroke is a list of stamps, an accumulated per-vertex weight field,
and one deformation of base → work. Weight accumulates as a **max** over
stamps, not a sum.

Two consequences, both deliberate:

- dragging back and forth over one spot **settles** instead of digging without
  limit;
- refinement part-way through a stroke can rebuild the whole result exactly,
  because there is still an undeformed base to rebuild it from. Refining the
  deformed mesh instead would bake the carve into the new midpoints and there
  would be nothing left to reset to.

## Re-triangulation, and why there is no T-junction sweep

A 20 mm cube face is two triangles. A 6 mm brush in the middle of it moves
**nothing**, because there is no vertex in the middle to move. Weighting harder
does not help — the surface has no degrees of freedom there. So the zone is
subdivided first, to `target = 2 * radius / samples` (samples 6), before any
deformation is computed.

Measured, `fixtures/box-20mm.stl`: 12 triangles in, 862 out for one 6 mm dab,
2002 for a five-dab drag. Without it the stroke is a no-op.

**The T-junction is prevented, not repaired.** The failure mode is the one the
Skin-wrap seam work hit and then had to sweep back out (the global T-junction
repair in `app-finish.js:1884`): trim each region in its own frame, and a cut
crossing an edge two regions share leaves a vertex on one side and not the
other. That sweep is a cure. This is the vaccine:

- splits are recorded **per edge**, keyed on the vertex pair, so both triangles
  sharing an edge are handed the **same** midpoint vertex id;
- **every** triangle is rebuilt each round, in zone or not, so a triangle
  outside the brush that shares a marked edge is re-split too;
- a triangle with 2 marked edges splits on the **shorter** quad diagonal,
  because the longer one is the sliver.

`NSO_brushTJunctionAudit` asserts this on real meshes rather than taking the
argument's word for it — the same sweep `app-finish.js` uses for its cure, run
as a detector. Measured: 0 T-junctions after refinement (2,982 edges checked),
0 after deformation, in every case in the suite.

Refinement is also proved **surface-preserving** before any deformation is
measured, or every later number would be measuring two things at once:
12 → 1,988 triangles with volume, surface area, open-edge count, Euler
characteristic and self-intersection count all identical.

## The seam band

The falloff reaches exactly 0 at the rim, so there is no cliff in the *weight*.
The artifact is in the *derivative*. With hard falloff the weight is still 0.84
halfway out and 0.47 at t=0.05, so the last ring inside the rim is dragged most
of the full depth while its neighbour one ring out has not moved at all. On a
coarse zone those two rings are a millimetre apart and the triangle spanning
them goes from equilateral to a near-degenerate spike — a sliver on
`tools/mesh_validate.py`'s own definition (longest edge over twice the
inradius, threshold 100).

So the band — every vertex on either side of the moved/unmoved boundary, grown
one ring — is relaxed. Three things about how:

1. **Strength is `(1 - w)`.** The deep floor of the dab is what the user asked
   for and is not touched; the rim, where `w` is near 0, relaxes fully. The
   relax therefore cannot eat the carve. Measured: max move 2.000 mm relaxed
   vs 2.000 mm unrelaxed on the hard-falloff case.
2. **Feature vertices are pinned.** The band reaches one ring *outside* the
   brush, into geometry the user never dragged over, and on a coarse piece that
   ring can be the actual corner of the part. A vertex whose incident face
   normals disagree by more than 40° is held still — measured on the box,
   26 of 92 band vertices pinned. `app-sculpt.js` says its global pass must
   never grow a feature term and that selective work belongs to the brush
   tier; this is the brush tier, and the term belongs here.
3. **Open-edge vertices are pinned**, for the same reason `NSO_smoothGlobal`
   pins them.

Feature angles are measured on the **base** mesh, not the deformed one: the
carve itself creates a steep wall, and measuring after would read that wall as
a feature and pin the very vertices that need relaxing.

## The gate

Everything is measured before and after with the **canonical** checker — the
browser transcription in `NSO_Repair.js`, which `tools/nso_selfint_equiv_test.js`
pins pair-for-pair against `tools/mesh_validate.py`. This feature does not get
its own copy. A refusal reverts; there is no "commit anyway with a warning".

Refuses on any rise in: **self-intersections (piercing)**, open edges,
non-manifold edges, backwards-wound edges, T-junctions, degenerate triangles,
sliver triangles, a volume sign flip, or volume moving more than 25% either way.

Triangle count is deliberately **not** a gate here, unlike `NSO_smoothGlobal`
where it is: refinement changes it on purpose, and a brush that refused to add
triangles could not carve a coarse face at all.

**A missing checker is a refusal, not a skip.** A gate that quietly does not
run when `NSO_Repair` is absent is not a gate.

### Why the self-intersection count has to be the gate

`fixtures/lid_blank.stl` is 60 × 40 × **2.4 mm**. Carve deeper than that and the
dished face comes out the other side — and the mesh stays **0 open, 0
non-manifold** the whole way. A mesh that has passed through itself is still a
perfectly watertight mesh. Measured, ungated: 0 → 68 piercing pairs, edge
counts unchanged. Through the real app with a real drag: 0 → 134, refused.

JS and Python agree exactly on the meshes this feature produces — piercing,
coplanar, sliver and degenerate counts all match, which no existing fixture
could have shown because none of these meshes existed before.

### The thin-wall bug this found

The first draft grabbed the **far** face of a thin wall: on `lid_blank.stl` a
20 mm brush on the top face has every vertex of the *bottom* face inside its
radius too — they are 2.4 mm away, the brush is twenty. Both faces were pushed
down together, the plate kept its thickness, and a stroke that should have
punched through instead embossed a dish and sailed through the gate because
nothing ever intersected. Volume moved 62 mm³ out of 5,760 and the piece
silently grew 4.8 mm on the axis it was being carved into.

Fixed by requiring a vertex's own (area-weighted) surface normal to agree with
the stamp normal. Area weighting, not a plain average, so one sliver in a
vertex's fan cannot outvote the face it actually belongs to.

## PAINT SCOPE: SUB-REGION

The standing rule in `docs/HANDOFF.md` is that a painted face stays untouched
by **any** bake. The scoping rule there says **how** a feature checks depends
on its operating shape, and the operand/veto rule added with **Delete painted**
says to answer two questions, not one:

> What does this act ON?   → the SELECT list, if anything.
> What must it not touch?  → the EXCLUDE list, always.

**The brush answers the first "nothing".** Its operand is a gesture — the
surface under the cursor, aimed by dragging — so it reads no SELECT list at
all, and `nsoMaskSelected` appears nowhere in `app-brush.js`. It reads the
EXCLUDE list, because the second question always has an answer. A tool whose
operand is a gesture is not an exception to the two questions; it is the first
one answered honestly.

The brush acts on an identifiable sub-region, so it checks only
**the faces the stroke lands on**, and
**paint on any other face of the piece does not stop it**.
This is the **same rule applied at a different scope** as Smooth's
whole-piece stand-down, **not** a laxer reading of it: global Laplacian
smoothing moves every unpinned vertex and has no sub-region to scope a check
to. This does.

**The seam band counts.** It reaches one ring outside the brush, into geometry
the user never dragged over, and the relax moves those vertices. A feature that
moves a vertex has to count that vertex as its own, so the **affected set** is
the brush disc **plus** the band — not the disc. Measured on the box: 69 brush
vertices, 193 with the band.

What does and does not stand it down:

| | |
|---|---|
| paint on the face under the stroke | **stands down**, naming the face |
| paint on the opposite face | does not |
| paint on a side face the stroke never reaches | does not |
| paint on a side face the stroke's rim **does** reach | **stands down** — correctly |

That last row is not a bug. At r=6 on a 20 mm face a drag from −4 to +4 reaches
x=10, which *is* the X+ face, and those vertices really do move. The test suite
shrinks the brush to make the "elsewhere" case, which is the honest way to test
it.

The planes come from `nsoMaskPlaneList` — added to `app-mask.js` for this, and
additive. `nsoMaskFaceList` is the axis-and-side view and returns `null` the
moment one entry is a recessed patch, because the whole-solid wrap cannot name
one; a sub-region feature needs the opposite, since a recessed patch is
perfectly usable to it and must not drop the whole list. Both read back what
the click wrote down. Neither re-derives which face was meant from a normal and
a bounding box — `docs/HANDOFF.md` is explicit that the second mapping is what
put the yellow on one face and the exclude on another.

A vertex lying **on** a painted plane counts as touching that face. That
over-triggers where faces share a corner, and over-triggering is the safe
direction for a rule whose whole point is that forgetting must not bake over
paint.

Checked **twice**: once on the first dab, so a stroke that cannot land is
refused before the user drags a groove they will not get, and once over the
whole stroke at pointerup, because the drag can travel onto a face the first
dab never reached. Same test, same wording, two moments.

## The interaction

- **Arm** with the Brush button. One armed tool at a time, both ways:
  `disarmOthers()` here is `app-measure.js`'s and `app-center-lock.js`'s, not a
  fourth dialect — a mode that has a button is turned off **through the
  button**, never by writing its state flag, because the button carries
  `aria-pressed` and the armed class. `state.maskPaint` is
  `false | 'exclude' | 'select'` since the paint grew its target list, so the
  click goes to whichever of `btn-mask-select` / `btn-mask-paint` is actually
  live — clicking the other would *switch* paint modes rather than stop it,
  which is exactly what the pre-merge draft of this function did. It stands
  Carve, Measure, Center-lock and Seat here down too; Measure and Center-lock
  turn the brush off through `btn-brush` in return.
- **Hover** shows a ring at the cursor, oriented to the surface normal, at the
  brush radius. It lives in the scene rather than the model group and has its
  `raycast` stubbed out, so it is never picked, never exported, and never walks
  into anything that iterates the pieces — the same trick `app-mask.js` and
  `app-sel-outline.js` use. Render order 60, above the paint's 40.
- **Drag** lays a dab every `0.25 * radius` of travel. Below about 0.2 the
  dabs are redundant (max accumulation makes them no-ops); above 0.5 a fast
  drag leaves a scalloped groove.
- **Release** runs the gate once and commits once.
- **Escape**, a lost pointer, or disarming mid-stroke all cancel cleanly.

`app-core.js` asks `window.nsoBrushTakesPointer(event)` before it starts a move
drag, alongside the `nsoMaskTakesClick`, `nsoCarveTakesClick` and
`nsoSeatHereTakesClick` asks and **ahead of** `nsoMeasureTakesClick`, on the
ordering rule all of them cite: if two
modes are somehow armed at once, the one that bakes should win the click rather
than have a measurement swallow it. It has to be asked, not asserted:
`app-core` binds inside `initThree()` while the document is still parsing, so
its capture listener on the canvas always runs first. Without the
ask, every stroke would also drag the piece and report "Moved model #N" over
the brush's own status. Verified in the drive check: x and z unchanged across
a full stroke.

### The preview is not a commit

During the drag the placed mesh is shown a throwaway geometry; `m.geometry` and
`m.rawTris` are **not touched**. Verified mid-stroke in the drive check:
`m.rawTris` still 12 triangles while the preview already showed 1,638. A
refused stroke, a cancelled stroke and a lost pointer all end by putting the
original geometry back and disposing the preview, so nothing downstream —
export, the checker, Join, the mask — can see a stroke that did not commit.

The preview runs the **same pipeline** the commit will: weights, deformation
and the seam relax are identical, and the commit adds the gate and the bake. So
what the user lets go of is what they get, unless the gate refuses it — and
then they are told why.

Two things the preview does differently, both stated rather than hidden:

- the display centring is **captured at pointerdown and held**. Rebuilding it
  per move (what `rawResultToDisplayGeometry` does, via `geo.center()`) would
  make the piece slide out from under the cursor as the carve changes its
  extent. The commit re-centres properly.
- only the triangles incident on vertices that moved are rewritten, using the
  vertex→triangle CSR map. On a piece with a hundred thousand triangles that is
  the difference between a brush and a slideshow.

## One shared-UI fix this feature forced

Adding four rows to the Finish menu broke `npm run measure`, and the cause was
not the rows. The menu had already outgrown its viewport: opened on a 720px
window it was taller than the space below its summary, so clicking a control
inside it made the **page** scroll to bring that control into view. That drags
the canvas up under the fixed header, and a click aimed at the piece lands on
the header instead. Measured: the scroll went from −157px to −251px when the
four rows landed, putting the measure test's second click 6px under the header.

The menu had reached that edge on its own — five threads added rows to it in
the same window this feature was being built — so the fix is not to make these
rows smaller. `.vp-finish-menu .vp-menu-body` now has
`max-height: calc(100vh - 96px)` and `overflow-y: auto`, so the body scrolls
instead of the page and the menu can never again be taller than the space it
has. That holds for every row in it, not just the last four added.

## Controls

| control | range | default |
|---|---|---|
| `#inp-brush-size` | 5–50 mm radius | 12 |
| `#inp-brush-intensity` | 0–1 | 0.5 |
| `#sel-brush-mode` | carve / emboss / smooth | carve |
| `#chk-brush-hard` | hard / soft falloff | soft |

Depth is keyed to radius, not to an absolute figure: `depthScale` 0.25 puts
full force at a quarter of the radius, so a 20 mm brush at intensity 1 digs
5 mm. A 50 mm brush that moved the same 2 mm as a 5 mm brush would not be a
brush, it would be a dent tool with a size slider that does nothing.

Falloff, with `t` = 1 at the centre and 0 at the rim:

- **soft** — `t²(3−2t)`, smoothstep, flat at both ends.
- **hard** — `t^0.25`, still 0.84 at t=0.5, so the floor of the dab is nearly
  flat and the wall steep. Measured through the app at the same size and force:
  soft removes 74.8 mm³, hard removes 141.3 mm³.

Both reach exactly 0 at the rim. A falloff stopping at a nonzero value would
put a step between the last selected vertex and its unselected neighbour at an
arbitrary place in the tessellation — a crease the mesh never asked for.

## API

```
NSO_brushMesh(adj)                        -> indexed mesh, detached
NSO_brushGraph(mesh)                      -> CSR neighbours + vertex->triangle + edge counts
NSO_brushToRaw(mesh, pos)                 -> flat Float32 soup
NSO_brushFalloff(t, falloff)              -> weight
NSO_brushVertexNormals(mesh)              -> area-weighted per-vertex normals
NSO_brushWeights(mesh, stamps, opts)      -> { w, nx, ny, nz, touched }
NSO_brushMergeStamp(mesh, field, st, ...) -> vertices whose weight changed
NSO_brushRefine(mesh, zones, opts)        -> { mesh, passes, splits, capped }
NSO_brushDeform(mesh, basePos, field, o)  -> new positions
NSO_brushSeamBand(mesh, graph, field, r)  -> { list, inBand }
NSO_brushRelaxSeam(mesh, graph, pos, ...) -> { moved, band, pinned, passes }
NSO_brushSliverAudit(rawTris, limit)      -> { slivers, degenerate, worstAspect }
NSO_brushTJunctionAudit(rawTris, opts)    -> { tJunctions, edges, capped }
NSO_brushSelfInt(rawTris, opts)           -> { ok, pierce, coplanar }
NSO_brushScore(rawTris, opts)             -> every number the gate reads
NSO_brushGate(before, after, opts)        -> { ok, reason }
NSO_brushApply(rawTris, stamps, opts)     -> one stroke, start to finish
NSO_brushPaintCheck(planes, points, tol)  -> { any, painted }
NSO_brushStandDownStatus(painted)         -> the status line
```

Sections 1–6 are headless — no DOM, no Three.js, no app state — so
`tools/nso_brush_test.js` loads the shipped file through `vm` next to
`app-sculpt.js` and `NSO_Repair.js` and drives the geometry directly.
Section 7 is the wiring and no-ops wherever the app's helpers are absent.

On refusal `ok` is false, `reason` says why, and `tris` is the **original**
soup — the same contract `NSO_smoothGlobal` keeps, so a caller can swap
unconditionally.

## Known limits, named rather than solved

- **Refinement is capped at 400,000 triangles.** A pass that would blow the
  budget is not applied at all (half a refinement round is not a mesh anyone
  wants) and `capped` says so. A very large brush on an already dense part
  therefore carves at whatever resolution it already had.
- **The self-intersection gate is global, not zonal.** Only the affected zone
  can change, so a zonal count would be cheaper — but the global count is the
  canonical number and matches "canonical checker before/after". It runs once,
  at pointerup, not during the drag.
- **The paint check is plane-distance only.** It does not consult the vertex's
  own normal, so a vertex at a shared corner counts as touching all the faces
  that meet there. Conservative in the safe direction, as above.
- **A stroke crossing onto a second piece is ignored**, not started over —
  `continueStroke` drops any move whose hit is not the piece the stroke began
  on.
- **Arming a paint button does not disarm anything** — including the brush.
  This is a pre-existing gap in `app-mask.js`, measured on this tree
  (2026-09-18): `btn-mask-paint` and `btn-mask-select` have no `disarmOthers()`
  and leave Carve and Measure armed exactly as they leave the brush armed. The
  consequence is that with paint on, a press on a piece goes to paint — it is
  asked first in `app-core.js` — and the other armed tool is silently dead,
  which is the failure the convention exists to prevent. Not fixed here because
  it is app-mask's arming protocol and touches four tools, not this one; the
  brush disarms paint correctly in its own direction. The drive check
  deliberately does **not** assert it, since that would be pinning a bug.
