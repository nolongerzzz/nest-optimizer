# Handoff (Claude Code reads this. User does not paste code.)

Branch: `claude-wip` only. Never push `main`.

**PR #4 is closed and already on main** (corners1, 2026-09-08, squash `4ea5eca`).
Do not reopen it. Do not comment on it. Do not treat it as a drop box.
New work: commit on `claude-wip`. Open a **new** PR if a review surface is needed.
Grok merges `claude-wip` → `main` and owns HUD / `?v=` tags.

## Standing rule — paint wins, for every bake
Owner's decision, and it binds new work as well as old: **a painted / excluded
face stays untouched by ANY bake mechanism**, not only the one the paint system
shipped with. A new bake feature reads mask6's skip list and either leaves that
face exactly as it was or stands down and says which face stopped it. It never
assumes nothing is painted — take the skip list as a required input, not an
optional one with an unpainted default, because unpainted is the value a caller
gets by forgetting.

Read the list, never re-derive it. `app-mask.js` hands back the raw axis and
side each click recorded; working out which face was meant from a plane and a
bounding box is the second mapping that put the yellow on one face and the
exclude on another. `brickSkipLists(...).pocket` and `nsoMaskFaceList` are the
supported ways in.

### Scoping — which faces a feature checks (added 2026-09-15)
The rule is one rule; **how** a feature checks paint depends on its operating
shape. Before wiring paint-awareness into a new feature, answer one question:

> Does this feature act on a specific, identifiable sub-region of the piece, or
> does it modify the whole piece with no clean sub-region?

- **Whole-piece** — stand down entirely if ANY face on the piece is painted.
  There is no sub-region to scope the check to, so this is the only coherent
  reading. The test is `nsoMaskCount(m) > 0`.
- **Sub-region** — check only the feature's own relevant faces. Paint elsewhere
  on the piece (a different pocket, the outer hull) does not block it.

Both are correct applications of the same rule at different scopes, **not**
inconsistent exceptions — do not "fix" one to match the other. Every
paint-aware feature **must state its category explicitly in its own
documentation**, so the next ticket reads it instead of re-deriving it.

Current roster, by category:

| feature | category | paint test | stated in |
|---|---|---|---|
| Smooth (`app-sculpt.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Extend (`app-extend.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/EXTEND.md` |
| Pottery Wheel (`app-wheel.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/POTTERY-WHEEL.md` |
| Repair (`app-finish.js`, Seal's checkbox) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Fusion (`app-join.js`, Join Route 0) | whole-piece | `nsoMaskCount(A)+nsoMaskCount(B) > 0` | stand-down comment |
| Thicken (`app-finish.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment |
| Pocket corners (`nso_inside_corners.js`) | sub-region | this pocket's floor + 4 walls | `docs/INSIDE-CORNERS.md` §2 |
| Seat here (`app-seat-surface.js`) | whole-piece | `nsoMaskCount(modelB)`, only when the seat must turn B | `docs/SEAT-SURFACE.md` §3 |
| Skin face (`app-skin.js`) | sub-region | the one face being skinned, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | header comment |
| Delete painted (`app-paint-delete.js`) | sub-region | the one TARGET face, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | `docs/PAINT-DELETE.md` §7 |
| Extract selection (`app-extract-sel.js`) | sub-region | the one TARGET face, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | header comment |
| Scale (`app-scale.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Skin patch (`app-skin-patch.js`) | **none** | — it reads no existing geometry at all | header comment |
| Texture (`app-texture.js`, the curved band) | sub-region | the band's own facets, `nsoMaskIsExcludedRaw(m, face.n, face.d)` per facet; the caps do not block it | `docs/CURVED-SKIN.md` §7 |
| Brush (`app-brush.js`) | sub-region | every face the stroke **and its seam band** land on, `nsoMaskPlaneList(m)` | `docs/BRUSH.md` §paint scope |

### The SELECT list is an operand; the EXCLUDE list is still only a veto

Added 2026-09-17, with **Delete painted** (`docs/PAINT-DELETE.md`). Read this
before the next ticket that wants to act ON painted geometry rather than around
it, because the obvious reading is the wrong one.

A tool that removes geometry does **not** read the yellow. The standing rule
above is unchanged and unweakened: yellow means "no bake may touch this face",
in a destructive tool exactly as in a bake, and a delete aimed at a yellow face
stands down and names it. What a destructive tool reads is the **pink** — the
SELECT list, "this face is my target" — which is the same list Skin face has
always taken its target from. Delete is that list's second consumer, not a new
kind of paint and not a new reading of the old kind.

So the rule of thumb for a new feature is two questions, not one:

> What does this act ON?   -> the SELECT list, if anything.
> What must it not touch?  -> the EXCLUDE list, always.

A feature that answers the first question with "the exclude list" is asking for
the one colour that means *protected* to also mean *doomed*, and that is not a
trade this file makes.

**The Brush answers it "nothing".** It acts on the surface under the cursor,
which the user aims by dragging, so it reads no SELECT list at all - and it
still reads the EXCLUDE list, because the second question always has an answer.
A tool whose operand is a gesture rather than a face is not an exception to the
two questions; it is the first question answered honestly.

**Extract selection answers it "the SELECT list", like Delete.** Added
2026-09-18, it is the pink list's third consumer and Delete painted's
non-destructive twin: same target, same exclude veto, same stand-down wording,
but it COPIES the target's region onto the plate as a new piece and writes
nothing back to the source. "Acts on" does not have to mean "damages" - the
first question asks what the operand is, not what happens to it. A feature that
only reads is still answering it, and still owes the second question an answer.

`node tools/nso_paint_scope_test.js` asserts every entry actually carries its
label in source, so a deleted or drifted declaration fails rather than rotting.
Its ROSTER covers the features with a stand-down to keep honest; add a row
there as well as here when you add one.

### Reading the target face as geometry
`NSO_PaintDelete.select(rawTris, entries)` is the one selector that turns a
painted entry list into the triangles it covers, in raw space. Delete painted
owns the file; Extract selection reads it too, and neither has a second copy of
"which triangles did that click cover". Hand it `[nsoMaskSelected(m)]` for the
pink target - the header there notes the shape is the same for either list.

It can legitimately resolve to zero triangles on a face that IS painted: a
click on a curved top names the Y+ face, and a sphere has no triangle lying on
that plane. The overlay shows nothing there either, so a caller must handle an
empty result rather than assume a painted face implies painted triangles.

**"none" is a category, not a gap.** Skin patch ADDS a piece built from the
pattern's own parameters and never touches a face of any existing one, so there
is no region for paint to protect - a stronger statement than "paint is
respected", and the reason it is not in the paint-scope suite's roster: that
roster is the paint-*aware* features, and a row there needs a paint test to
assert. The drive check pins the substance instead, by loading a cube, baking
all six patches and showing its geometry, size and flag untouched.

## Standing rule — non-solid is the user's call, never the mesh's (added 2026-09-16)
A piece can be flagged **non-solid** (the *Non-solid* checkbox, `m.nonSolid`,
`nsoNonSolid(m)`), meaning it is meant to be open: a vase-mode clip, a
single-wall squishy, a woven sheet of separate strands. Same shape as paint:
per piece, user-set, visible (list tag + checkbox + status lines), undoable,
never inferred from an edge count. What it lifts is exactly one thing, the
"fully enclosed" requirement — hole fill, flap and orphan peel, open-edge
verdicts, volume-based budgets. **Self-intersection, degenerate, non-manifold
and winding checks run unchanged with the flag on.** Full audit, the split per
consumer, and the wall/gap check for thin shells: `docs/NON-SOLID.md`. A new
consumer states `NON-SOLID SCOPE` in its source and reads `nsoNonSolid(m)`;
`node tools/nso_open_flag_test.js` pins it.

Pass/fail for a flagged piece is `tools/mesh_validate.py --gate --non-solid`
(open edges leave the verdict, the wall/gap check joins it), or
`tools/stl_watertight_check.py --odd --degen --non-solid`.

**Corollary, added 2026-09-17 after it bit:** standing a closure stage down
never licenses the stages that keep running to leave the surface **more open
than they found it**. `NSO_Repair`'s degenerate strip opens boundary as a side
effect of doing its job — a zero-area sliver is usually the stitch holding a
coarse edge to the two finer ones it was split into — and with hole fill
skipped there was nothing left to put those seams back, so the final odd-edge
gate discarded the whole repair. On `fixtures/tape_welded_clustered.stl` that
cost 295 degenerate strips, 288 T-junction splits and a 56-pair drop in
self-intersections, over 15 edges the repair itself had opened. The rule the
flag actually encodes is: **a stage may undo damage this run did; no stage may
close, peel or drop boundary the piece arrived with.** `commit()` records the
arrival boundary before any stage runs and `seam-reclose` closes only loops
containing none of it. If you add a flag consumer that DELETES geometry, this
is the half of the rule that is easy to miss.

## Standing rule — the checker has one definition, and now it draws (added 2026-09-17)
`tools/mesh_validate.py` is still the canonical definition of every check.
What changed is that the browser can now show you WHERE: the *Check piece*
button (`app-defects.js`) runs the battery on the selected piece and paints the
findings on the mesh — red on open edges and piercing pairs, orange on
non-manifold edges, violet on faces under the 0.42 mm wall/gap floor. Full
write-up: `docs/DEFECT-OVERLAY.md`.

The rule this sets for anything that comes after it: **do not write a fourth
checker.** `nso-defects.js` adds coordinates to the checks that already exist
and nothing else — the piercing pairs are the pairs `NSO_Repair`'s own
`testPair` counted (an off-by-default `{ collect: true }` that changes no
count), the edges come from the same `buildEdges` table `analyze()` counts. The
one piece of new code is the wall/gap raycast, because there was no browser
copy of it, and it is transcribed line for line and pinned:
`node tools/nso_defect_overlay_test.js` holds `locate()` to
`mesh_validate.py --min-wall 0.42 [--non-solid]` on every STL in the repo, and
`node tools/nso_defect_overlay_drive_check.js` drives the button in Chromium
and measures each painted vertex against the displayed mesh in world space
(worst gap 0.000000 mm). Both are in `npm test`.

Two numbers in `locate()` are the validator's rather than
`NSO_Repair.analyze()`'s — degenerate (raw soup, not welded) and winding
(directed reuse, not undirected). Both differences predate this work and are
pinned from both ends in section 2 of the test, so neither can drift quietly.
## Standing rule — a library entry resolves to an ABSOLUTE url (added 2026-09-18)
`app-library.js` no longer concatenates `'library/' + name`. It carries a
`SOURCES` table — one entry per library, each with a `base` URL — and every
catalog row names a source. `resolve(entry)` is the only way a file name
becomes something fetchable, and what it returns is a full absolute URL:
scheme, host, path.

Today there is one source and it is this origin, so the bytes fetched are
identical to what the old concatenation fetched. That is the point: the cost
of the rule is zero now, and it is the whole difference later. With a
relative path, "the library" and "this repo" are one statement, and the
fetch, the row tooltip and anything that later wants to say where a piece
came from have all quietly assumed it. With a base per source, a library in
another repo is one new row in `SOURCES` plus entries naming it — no new
code, no fetch change, no UI change.

Two things to keep:

1. **Never write a base as a literal `https://…github.io/…`.** The built-in
   source resolves its base against `document.baseURI`, so it is absolute on
   every origin the page is served from — including the local test harness,
   where a hard-coded production host would be a different origin. A second,
   genuinely remote library is the case where a literal base is correct.
2. **Templates are not catalog entries.** A template stores generator
   parameters, not a file path; `resolve()` has nothing to say about one.
   When they arrive they get their own structure rather than a `category` in
   this taxonomy.

The taxonomy itself (`CATEGORIES`) is a rough first cut and expected to grow:
Skins, Supports, Washers, Shaped Pieces, Test Fixtures. A category with no
entries is simply not drawn, so adding a name ahead of its members is free.
`tools/nso_library_browser_test.js` pins all of it — absolute URLs on every
entry, the grouping, the categories, and that From File still drives
`#file-input` untouched.

## Standing rule — a new Finish row goes IN a group (added 2026-09-18)
The Finish menu is six `<details>` groups plus one footer row, not a flat
stack. It got there because five threads in one night each appended a row to
the bottom without seeing the others: 29 rows, 49 controls and 988px of
content in a 176px column, of which a 720px-tall window could show 63%. An
earlier thread had already capped the body with `max-height` + `overflow-y`
(`styles.css`, `.vp-finish-menu .vp-menu-body`) — keep that, it stops the page
scrolling the canvas under the header, but it is the backstop, not the
structure.

The groups, and what decides which one a row belongs to:

| Group | Holds |
|---|---|
| **Shape** | changes the form: Soften, Smooth, Extend, Thicken |
| **Paint** | the mask itself: Paint Selected / Excluded / Clear, Delete painted, Extract selection |
| **Surface** | adds relief to a face: Skin face / wrap / patch, Texture |
| **Sculpt** | freehand and local: Brush, Carve |
| **Measure & check** | read-only inspection: Measure, Check piece. Nothing here may mutate the piece — that is the line the group is drawn on, so a tool that bakes does not belong in it however diagnostic it feels |
| **Check & repair** | finds or fixes defects: Cap open faces, Repair, Seal, Non-solid, Solidify |

*Clear plate* is outside every group on purpose: it is the only control that
is not about the selected piece, and it must never be a click hidden behind a
fold.

Three things to keep when you add to it:

1. **Put the row in a group, and put its parameters in the same group.** The
   win here was not the headings, it was that rows serving one tool stopped
   paying rent — Soften's R / Full wrap, Texture's pitch and depth, Carve's
   four numbers and its readout are 217px that used to sit in the column
   whether or not the tool was in use.
2. **Do not put a border or side padding on the group.** Every row in this
   menu is sized against the 166px the body gives it, and `.vp-row-skin2` is
   fitted to the pixel so "crosshatch" clears its select's arrow. A boxed
   group would take 10px off all 29 rows at once. A group is a heading with a
   rule under it.
3. **Reach your control in a drive check through the harness.** `openFinishMenu()`
   (`tools/nso_app_harness.js`) opens the menu AND every group, so a check
   asserts what a control does rather than which fold it is in. If you open
   the menu your own way, call `openFinishSections(page)` too — that is the
   whole reason `nso_thicken_drive_check.js` needed one line and the other 25
   menu-dependent checks needed none.

## Local brush - freehand surface deformation (added 2026-09-18)
`app-brush.js`, wired at the current `?v=inside6` tag. Carve / Emboss /
Smooth-here on one brush mechanism: size 5-50mm, one intensity slider,
hard/soft falloff, a ring on hover. Full write-up: `docs/BRUSH.md`.

It is the **only** drag-to-paint interaction in this app and the only live
uncommitted preview, and it still is after the five-thread land: Carve,
Measure, Delete painted, Texture and Center-lock are all click tools, and the
only drags in the repo (move-on-plate, the cutter helper, yaw) touch no
geometry. `grep -n pointermove app-*.js` finds exactly three files - app-core
for those drags, app-seat-grid to copy a pose, and this one. The audit that
established that is in `docs/BRUSH.md` and at the top of `app-brush.js`; read
it before adding a second dragging tool, because the three mechanisms it had
to invent - an unpressed pointermove path, a stroke session that commits once,
and a light live refresh - are reusable and worth not writing twice.

Four things that bind new work:

- **`app-core.js` asks `window.nsoBrushTakesPointer(event)`** before it starts
  a move drag, alongside the Carve and Seat-here asks and ahead of Measure, on
  the ordering rule all three cite: the brush bakes, Measure cannot. Another
  tool that claims a press adds its own ask in the same place; it cannot bind a
  canvas listener and expect to win, because app-core binds during parse.
- **The brush is in the mutual-disarm protocol**, both ways.
  `app-brush.js`'s `disarmOthers()` is app-measure.js's, not another dialect -
  a mode with a button is turned off THROUGH the button, and the paint click
  goes to whichever of `btn-mask-select` / `btn-mask-paint` is live, because
  `state.maskPaint` is `false | 'exclude' | 'select'`. It also stands Seat here
  down, and app-measure.js / app-center-lock.js turn the brush off through
  `btn-brush` in return.
- **PAINT SCOPE: SUB-REGION**, and the affected set is the brush disc PLUS the
  one-ring seam band the relax moves. A feature that moves a vertex counts that
  vertex as its own. Operand: none - see the two questions above.
- **`nsoMaskPlaneList(m)`** is the supported way in for a sub-region paint check
  that starts from POINTS rather than from a face: the excluded faces as raw
  planes, recessed patches included. `nsoMaskFaceList` returns null the moment
  one entry is recessed, which is right for the whole-solid wrap and wrong for
  anything holding a set of points. Neither re-derives anything.

`npm run brush` (91 checks, headless geometry, canonical checker before/after
on a flat face, a curved surface and a 2.4mm thin wall) and `npm run wire:brush`
(61 checks, real pointer events in the real app, including the disarm protocol
in both directions). Both in `npm test`.

**The Finish menu now scrolls instead of growing**, and that is a shared fix
worth knowing about before the next row lands in it. It had outgrown the
viewport: opened on a 720px window it was taller than the space below its
summary, so clicking a control inside it scrolled the PAGE to reach that
control, dragging the canvas up under the fixed header until a click aimed at
the piece hit the header instead. That is what broke `npm run measure` when the
brush rows landed - the scroll went from -157px to -251px. `.vp-finish-menu
.vp-menu-body` is now bounded (`max-height: calc(100vh - 96px)`,
`overflow-y: auto`), so the body scrolls and the viewport stays put however
many rows the menu grows.


## Output protocol
1. Findings, numbers, diffs, and next-step proposals go in the current ticket PR
   (a new PR off `claude-wip`) or in the commit message. Never PR #4.
2. Chat carries a short status line. No full script dumps. No `app.js` token.
3. Never apply `stash@{0}` or any parked patch unless Grok or this file says **APPLY**.
4. Never bump `?v=` tags — Grok owns the HUD string (`stampHud()` in the UX script).
5. Pass/fail is math: `tools/stl_watertight_check.py --odd --degen` plus the
   geometry probes the current ticket names. Never call a mesh correct from a screenshot.

## Ping pong
A bare STL drop, no text, is the latest live export for the current ticket.

- Run the checker and the ticket probes.
- Commit or comment on the **current** ticket PR.
- Ticket fails → one scoped patch on `claude-wip`, then a short status line.
- Ticket passes every named gate → comment "this is correct" with the numbers, no further patch.
- A decision is needed → one question, then `I need your attention`.

## Current factory (do not rewrite from this file)
Live HUD is `inside3`. Finish wrap + paint + pocket bake is the open factory path.
CTH is gated (`?cth=1` / `?cth=finish` / `?cth=drive`) and removable.
Parked modules (repair, sculpt, planar fuse) stay unwired until the owner names a ticket.
Clean no-op mesh for repair checks is `fixtures/box-20mm.stl`, not Thingi10K 40921
(40921 has 17 bowtie vertices; edge-based checks miss that).

## 3MF export - baked cooling settings
`nso-cooling-profiles.js` + `nso-3mf.js`, wired into `app-core.js` (the
export-format block and the `export3MF` block) and `app-join.js` / `app-ux.js`
(the buttons and the right-click item). Full write-up:
`docs/baked-cooling-settings.md`.

Unlike repair / sculpt / planar fuse, this one **is** wired in. The entry point
is one **Format** selector (STL / 3MF) at the top of the Export card, remembered
in `localStorage` as `nso.exportFormat`. It drives **Download selected**,
**Export plate** and the right-click **Export** item alike, relabelling them; the
cooling-profile row only shows for 3MF. There is no separate 3MF button any more
(`#btn-export-3mf` is gone; the plate button keeps its `#btn-export-stl` id
because app-cut.js and app-core.js enable/disable it by that id). "Download
selected" with 3MF is `exportActiveModel3MF()`: the active model as a one-object
project, same axis swap and bad-triangle filter as `exportActiveModel()`, set
down centred on the current plate resting on z = 0, same filename prompt.

`main` (the live site) has none of this yet - no 3MF modules, no Format
selector; that is a `claude-wip` -> `main` merge, Grok's call.

## Extend - axis-preserving stretch
`app-extend.js`, wired at the existing `?v=inside4` tag straight after
`app-sculpt.js` (it reuses `NSO_sculptCommitRaw` and the sculpt measurement
helpers). UI is an **Extend** button plus a length box in the Finish menu.
Full write-up: `docs/EXTEND.md`.

Lengthens a piece along its one dominant straight axis and holds the
cross-section perpendicular to that axis **bit for bit** - not to a tolerance.
A gate inside `NSO_extendRaw` compares every non-axis coordinate against the
input on each run and refuses if one moved. Distinct from Scale-to-size, which
moves all three axes and would change every functional dimension on the piece.

Three things a later ticket should read before touching this:
- The perpendicularity gate is a **derived, per-triangle** tolerance, not a
  fixed one. Measured: the same flat wall reads `|n.u|` 3.4e-9 at the origin
  and 2.8e-6 at a +1400 mm offset, so a fixed 1e-6 gate refuses a correct
  piece. The achieved-length gate is counted in float32 ULPs for the same
  reason. `docs/EXTEND.md` findings 1 and 3, with the numbers.
- **`pin.stl` extends correctly and should.** The ticket expected it to refuse;
  measurement says its 0.1 mm end chamfers are end features, not a taper, and
  its 19.8 mm shaft is a clean band. The gate belongs on the cut region, not on
  the whole piece. Finding 4. The real taper refusal case is a cone, built in
  the self-test.
- Built before `app-scale.js` was visible from its branch point, so the two were
  compared only at merge. They converge: both probe-measure-correct in at most
  four passes, and `NSO_scaleGate` already scales its weld quantum and area
  epsilon by the factor for the same reason Extend counts in ULPs. Scale's
  tolerances track the FACTOR, Extend's track the coordinate MAGNITUDE (its
  factor is always 1). `docs/EXTEND.md` "Against Scale-to-size".
- **Re-tiling is not this.** Stretching `hinge_knuckle_box` makes one 3.6 mm
  finger longer rather than adding a finger - exact, and it will no longer
  interleave with its lid. "Stretch the border, re-tile the interior" is a
  separate ticket.

`npm run extend` (54 checks, headless), `npm run extend:canonical` (50 checks,
`tools/mesh_validate.py` before/after, machine-compared) and
`npm run wire:extend` (28 checks, real app). All three in `npm test`, along
with `npm run paint:scope`, which was written but never wired into the suite.

## Pottery Wheel - throw a vessel on an axis
`app-wheel.js` + `app-fit.js` + `nso_printer.js`, wired on their own
`?v=wheel1` tag (new files, so no existing tag was bumped) after `app-sculpt.js`
(it reuses `NSO_sculptCommitRaw`) and after `app-extend.js` (rim extension
calls it). UI is a **Wheel** menu in the viewport, beside Finish. Full
write-up, with every number: `docs/POTTERY-WHEEL.md`.

Four moves in the order a potter makes them - **Ball** (sized from a target
height by Pappus's centroid theorem), **Open** (one push; the single outer
profile becomes outer + inner and the piece is a shell from there), **Pull**
(drag-shape the profile at ANY height, spline-fitted, revolved to a clean
solid each update), **Trim** - plus **Rim +**, which is `NSO_extendRaw` and
not a second copy of it.

The piece is held as its MERIDIAN PROFILE and revolved fresh every update.
That is the decision everything else follows from: the two live constraints
are a scan of ~100 samples rather than a mesh query, which is what makes them
affordable per frame of a drag.

Four things a later ticket should read before touching this:
- **The cavity is not `outer(z) - wall`.** A radial subtraction leaves a
  perpendicular wall of `wall * cos(slope)` - measured at 1.446 mm where 3.00
  was asked, 51.8% under, worst near the base. Open bisects for the locus at
  perpendicular distance `wall` instead, which also sets the cavity floor and
  the rim for free. `docs/POTTERY-WHEEL.md` finding 2.
- **The wall floor is `NSO_Thickness.floorFor` and nothing else.** No `0.42`
  in this file, no default: loaded without `nso_thickness.js` it throws on the
  first move. The MEASUREMENT is this file's own exact scan, though, because
  `measureLoop`'s ray pass under-reports a meridian by 1.47 mm on a 3 mm wall
  (its `u in [-0.05, 1.05]` slop against short cavity-floor segments). Finding
  5 - and it is pinned by a test, so a fix to `loopWallAt` shows up here.
- **A vertical outside is not a vertical inside.** Pull carries the inner wall
  radially by default (cheap, exact in the radial gap). Pulling a wall
  straight that way leaves Extend refusing at 384/384 straddling triangles
  oblique; `opts.reshapeWall` rebuilds the inside from the outside and gives
  an 8.85 mm clean band. Finding 3.
- **`tools/nso_wheel_canonical_check.js` earns its place.** It caught a pulled
  bowl claiming a base at z = 0 while the mesh started at z = 0.112 - a Pull
  clamping radii to zero leaves a run of axis points the revolve drops, and
  nothing inside the wheel could see it. `NSO_wheelTidy` is the fix; the bbox
  comparison is a permanent gate. Finding 6.

Explicitly out of scope for this first version, and both real: **non-symmetric
appendages** (handles, spouts, feet - a meridian profile cannot express one;
that is a Join ticket) and **centring an arbitrary / asymmetric starting
mesh** (there is deliberately no entry point that takes a mesh in). The
self-test greps for both and fails if either appears.

`npm run wheel` (94 checks, headless), `npm run wheel:canonical` (80 checks,
`tools/mesh_validate.py` over every revolved piece, machine-compared, budget
included) and `npm run wire:wheel` (53 checks, real app). All in `npm test`.

## Build volume - does the piece fit the machine?
`nso_printer.js` (the per-printer profiles and the fit arithmetic, no deps,
Node and browser) + `app-fit.js` (the live watcher). Wired at `?v=wheel1`.
Full write-up: `docs/BUILD-VOLUME.md`.

Strictly "will this bounding box fit inside that machine". **Not** a
printability check: bridging, overhangs, wall thickness and severed
connections are separate, already-existing concerns, and a piece that fits and
cannot be printed produces no warning here. `tools/nso_printer_fit_test.js`
asserts that structurally - strip the comments and no code in `nso_printer.js`
mentions any of them, and it references no other NSO module at all.

Profiles are keyed to `app-core.js`'s `PLATES` ids one for one, so the plate
selector resolves straight into a profile. `PLATES` carries bed X/Y only; this
adds the **build height**, which is the axis the plate picker never modelled
and the one a thrown vessel runs out of first. Where one id covers several
machines the height is the LOWEST (`prusa` takes the MK3S's 210, not the MK4's
220): a warning that fires early on the taller machine is a warning, one that
stays silent on the shorter machine is a failed print. `custom` gained an
`#custom-h` field and `getCurrentPlate()` now returns `h`.

Two things a later ticket should read:
- **The live check is a poll, deliberately.** A bbox changes from a dozen
  places, and hooking all of them means every future tool has to remember to
  call it. `app-fit.js` runs one rAF loop over a cheap signature - plate id,
  custom fields, each model's three sizes - and recomputes only on a change.
  A tool that changes a piece's size gets the warning whether or not its
  author heard of the file. It is also why this is not an export-time gate.
- **Only the 90 degree turn is offered.** `rotatedFits` is exact in a line. An
  arbitrary-angle placement is out of scope and named: a 260 x 20 mm bar does
  fit diagonally on a 256 mm bed and this says it does not. Placement is
  `packModels()`; a piece that only fits on the diagonal deserves a human.

The real case it was built against is in `npm run fit` section 5: a 320 mm
floor vase actually thrown on the wheel, raised 30 mm at a time, whose BALL
still fits an A1 Mini and which trips the warning at stage 4 (180.278 mm, 0.278
over). The revolved solid is then put through the canonical checker and the
checker's own bbox asserted to give the same verdict. `npm run fit` (70
checks) and `npm run wire:wheel` sections 9-10 (the warning appearing
mid-throw and clearing when the plate changes, nobody pressing Export).

## Standing rule - a second viewport menu, and the accordion that bit
Found at the Pottery Wheel merge, and it will bite the next person who adds a
viewport `<details class="vp-menu">`.

`.vp-menu` is an **exclusive accordion**: the `toggle` handler in
`app-join.js` closes every other menu when one opens. Correct for users - the
menu bodies overlap - and invisible for as long as **Finish was the only
`.vp-menu` on the page**. The Wheel menu is the second one, and five suites
broke the moment it landed:

    nso_paint_arming_test   nso_pose_after_bake_test   nso_center_lock_test
    nso_flip_port_test      nso_wire_fuse_test

All five did `querySelectorAll('details').forEach(d => d.open = true)` and
then clicked a button inside Finish. With one menu that worked; with two, the
last toggle to fire closes Finish and the button is `not visible`.

**The subtlety that matters, because the obvious fix does not work.** `toggle`
on a `<details>` fires **asynchronously**. So re-opening Finish in the same
evaluate is a no-op - it is still `open` at that instant - and the queued
accordion handlers then close it anyway. The fix has to let the toggles settle
first:

```js
document.querySelectorAll('details').forEach(d => { d.open = true; });
await new Promise(r => setTimeout(r, 0));          // let the accordion settle
document.querySelectorAll('.vp-menu').forEach(m => {
  m.open = m.classList.contains('vp-finish-menu'); // then say which one
});
await new Promise(r => setTimeout(r, 0));
```

All five now do exactly that, so a **third** menu will not break them again.
A new drive check should open the menu it needs by name rather than opening
everything - the pattern `nso_wire_smooth_test.js`, `nso_wire_extend_test.js`
and `nso_wire_wheel_test.js` already use (walk up from the button to its
`DETAILS` and open that chain) is accordion-proof and needs no settle.

## The wheel's wall floor - the vendoring is over, resolved at the merge
The Pottery Wheel branch carried a VENDORED copy of `nso_thickness.js` (from
`claude/wall-thickness-nozzle-safety-axpwtt` at `a017e12`), because the wall
floor had to be the canonical one and that branch was not merged at the time.

**Both have now landed on `claude-wip`, and the vendoring is resolved.** The
wall-thickness branch's own version won the add/add conflict, deliberately: it
is `80caaa6`, a strict superset of what the wheel vendored - same `floorFor`,
same `measureLoop` (checked call-for-call, identical output on a meridian),
plus `cutClearance()` / `cutWarning()`, which the older copy did not have. The
wheel's copy would have been a silent regression.

So there is now ONE `nso_thickness.js` and one `docs/WALL-THICKNESS.md`, and
`tools/nso_wall_thickness_test.js` - which the wheel branch could not carry,
since most of it A/Bs the retrofit of `app-cut.js` / `app-finish.js` - is in
`npm test` alongside `npm run wheel`. Nothing is duplicated and nothing is
pinned to an old revision.

What the wheel adds on top is unchanged by any of that: it takes its floor
from `NSO_Thickness.floorFor()` and carries no literal, and it deliberately
does NOT use `measureLoop` as its live gate - see finding 5 in
`docs/POTTERY-WHEEL.md` for the 1.47 mm the ray pass loses on a meridian.

## 3MF import - geometry only
`nso-3mf-read.js` (UMD, no deps, same code under Node and in the page), called
from `handleFiles()` in `app-core.js` for `.3mf`; `#file-input` now takes
`.stl,.3mf`. One model per build item, transforms applied, names from Bambu's
`model_settings.config` / `<object name>` / the file name. The STL and 3MF
branches share `addModelFromZUpGeometry()`, so an imported 3MF object has
`rawTris` in file axes exactly like an STL and Cut / Sculpt / both exporters
treat it the same. Full write-up, including what is out of scope (settings,
paint, multi-plate, `.gcode.3mf` without a model part): the "3MF import"
section of `docs/baked-cooling-settings.md`.

Real-file evidence: Bambu Studio's own calibration files (`fixtures/3mf/`,
AGPL, two different layouts incl. ZIP64 and the Production extension) and a
MakerWorld project saved by BambuStudio-02.07.01.62 (not committed; run it with
`NSO_3MF_REAL=...`). Every object read back passes
`tools/stl_watertight_check.py --odd --degen` and has positive signed volume.

`npm run 3mf:import` (55 checks, +8 with `NSO_3MF_REAL`) and
`npm run 3mf:import-drive` (21 checks, real app in headless Chromium: the two
fixtures in, an imported object out through both export routes, NSO's own
export re-imported corner for corner, a junk `.3mf` reported not thrown). Both
in `npm test`.

Two things must not be "tidied up", both confirmed against a real Bambu export
(stock Bambu PLA Basic @BBL A1M):
- every value is a single-element array of strings, `["50%"]`, never a scalar;
- percent fields keep the literal `%`, plain numeric fields do not, even where
  the number is semantically a percentage (`overhang_fan_speed` is `"100"`,
  `fan_max_speed` is `"80"`). Bambu's own inconsistency. `KEY_FORMATS` in
  `nso-cooling-profiles.js` pins this per key and `validateValues()` runs on
  every export, so a tuned profile cannot silently add or drop a `%`.

`DEFAULT_VALUES` is the confirmed stock set and is frozen. Tuned profiles are
`overrides` layered on top of it - `breakaway-support`, `fine-detail` and
`high-flow` are reserved and untuned, and export identical to `default` until
someone fills them in. Adding a tuned profile means editing that one table and
nothing else.

`project_settings.config` carries only the 14 confirmed cooling keys. NSO's own
bookkeeping lives in `Metadata/nso_profile.json` instead, because Bambu warns on
keys it does not recognise.

Known limitation, confirmed by testing and **documented rather than solved**:
swapping filament presets in Bambu Studio after opening an export raises "Use
Modified Value of Filament Preset", and "Discard Modified Value" drops the baked
settings silently. Inherent to how Bambu reconciles a project against a preset.

Settled: the container is JSON with `:`. The owner pulled the keys with
`json.load()`, which only parses valid JSON; the `key = ["value"]` form in the
ticket was shorthand. Serialization is correct as written.

Still open, and the one thing no check here can reach: **nobody has opened one of
these in a real Bambu Studio instance.** The doc carries a key -> Cooling tab
field table to check against, what does and does not count as coercion (the
speed fields are stored bare and rendered with a `%` - that is expected, not a
rewrite), and the likeliest failure mode if it fails at all: NSO writes only the
14 cooling keys and no preset-identity envelope. Record the outcome in the doc.

Out of scope here: the Grispr G-code post-processing path for multi-material.

## Toolpath import - a sliced .gcode.3mf as real geometry
`nso-gcode-lines.js` (UMD, no deps, same code under Node and in the page) reads
`Metadata/plate_N.gcode` out of an already-sliced Bambu Studio project and turns
every extrusion move into a closed flat-line solid at the width and height that
move actually prints at. `app-toolpath.js` puts them on the plate - one model per
`; FEATURE:` group, through `addModelFromZUpGeometry()`, so an imported feature is
an ordinary NSO model from there on - and adds the **Toolpath** card: a scrub
control that steps ONE MOVE AT A TIME within a layer, and **Extract Line**, which
pulls the scrubbed selection out as its own standalone object.

The point of the whole thing: Bambu Studio cannot scope a job to one line. Import
the toolpath, extract the piece, export it on an empty plate - the isolation
happens before the slicer ever sees it. Full write-up, including what "watertight"
means for a stack of beads and why `stl_watertight_check.py --odd` is the wrong
flag for these exports: `docs/GCODE-TOOLPATH-IMPORT.md`.

Widths are **measured, not assumed**: `w = A/h + h(1 - pi/4)` with `A` from the
move's own E and distance, filament diameter from the file's own config comments,
`h` from the file's own `; LAYER_HEIGHT:` or the measured Z step. Every move
records which source its height came from and `meta.assumed` goes true if
anything at all fell back to a constant - the checks assert it is false.

`npm run gcode:lines` (81 checks, +8 per real file with `NSO_GCODE_REAL`) and
`npm run gcode:drive` (58 checks, the real app in headless Chromium: the file
handler, the slider stepping line by line, the highlight isolating exactly one
move, Extract Line, undo, and the real **Download selected** button in both
formats, with the saved file re-opened from disk and checked to hold only the
extracted feature). Both in `npm test`.

Scope, and it is a hard line: **import and render only.** Not a slicer, not live,
and no attempt to predict Bambu's slicing decisions. Input is always an
already-sliced file.

Two things here are not settled, both recorded rather than papered over:

- **No real sliced file has ever been through this.** There is no
  `.gcode.3mf` in this repo or its history, so every number above is proven
  against synthetic ground truth (`fixtures/3mf/toolpath-ground-truth.gcode.3mf`,
  generated so the correct answer is known exactly) and against the real app -
  not against a file Bambu Studio wrote. `NSO_GCODE_REAL` runs that tier; nobody
  has run it. **This is the next check.**
- **`; FEATURE:` grouping is only as good as the tags.** Bambu's feature names
  are taken verbatim and not normalised, so a firmware or slicer version that
  renames them changes the model names. That is deliberate - the file's own words
  - but it means the names are not a stable API.

## 3MF checks
`npm run 3mf:roundtrip` is the dependency-free suite (56 checks): it exports a
real `.3mf` and reads it back with an independent ZIP reader, asserting key set,
key order, array-of-string shape, byte-exact values including `%`, raw text
form, determinism, and that the format guard rejects bad values.
`npm run 3mf:drive` (63 checks) drives the real app in headless Chromium -
the Format selector (labels, cooling row, persistence across a reload), fixture
import, a clone so the plate carries two pieces, the actual **Export plate**
click with Format = 3MF, the actual **Download selected** click with Format =
3MF (filename prompt accepted), the plate click again with Format = STL - then
takes both saved 3MF files apart (14 keys, `%` rule, one object per piece / one
object for the selected model, on-plate coordinates) and sanity-checks the STL.
It deliberately does **not** press Optimize: `runOptimize()` throws on this
branch (it reads `#opt-orient` / `#opt-rotate`, neither of which is in
index.html - already true at 63c5b00). An earlier draft of the check did press
it and asserted `state.placed.length > 0`, which passed for the wrong reason,
since `handleFiles()` already places the imported piece. Both are in `npm test`. Like the CTH
browser checks, the drive serves three from devDependencies, not the CDN.

**No `CHROME_PATH` is needed, in the sandbox or anywhere else the browser is
already on the box** (2026-09-17). The devDependency is pinned to an exact
`playwright` version - `1.56.1`, not a `^` range - chosen because it is the
Playwright whose browsers.json asks for Chromium revision **1194**, which is the
revision the web sandbox ships at `/opt/pw-browsers` (Chromium 141.0.7390.37),
together with `chromium_headless_shell` 1194 and `ffmpeg` 1011. A clean
`npm install` therefore lands a Playwright that finds its browser where it
already is, and bare `npm test` exits 0.

What that pin replaced: `^1.47.0` resolved to whatever npm called latest
(1.63.0 by 2026-09-17), which wants Chromium 1243, so `npm test` died at step 2
on `browserType.launch: Executable doesn't exist at
/opt/pw-browsers/chromium_headless_shell-1243/...`. Not a code failure - the
four dependency-free cth:unit files passed first and the chain stopped at
`cth:capture` - but every thread that hit it worked around it separately
(`CHROME_PATH=/opt/pw-browsers/chromium npm test`, or a hand `--no-save`
install of a matching Playwright). The sandbox cannot fetch the missing build:
`npx playwright install` is refused by the egress proxy
(`403 ... no rule or allowlist entry allows host "cdn.playwright.dev"`), so
matching the pin to the box is the only fix that needs no per-run flag.

If you move the sandbox image to a different Chromium revision, re-pin rather
than re-introduce the env var: read the wanted revision out of a candidate's
`node_modules/playwright-core/browsers.json` (or `npx playwright install
--dry-run`, which prints the install location per browser) and pick the
`playwright` version whose number matches the box. `CHROME_PATH` still works as
an escape hatch - `cth-test/browser-lib.mjs` and the two `3mf-test` drive checks
read it - and `tools/nso_app_harness.js` resolves the binary itself in
`chromiumPath()`, so the harness suites never needed it.

## Export round trip + fixture integrity - standing checks (added 2026-09-16)

Two suites added after the infrastructure health pass, both in `npm test`.

**`npm run export:roundtrip`** (`tools/nso_export_roundtrip_test.js`, ~40
checks, headless Chromium through `nso_app_harness`). The general form of the
liftY bug fixed in 1cef66a. Two pieces are posed off-centre - box-20mm yawed
0.7 rad and lifted 3.37 mm, the pocket brick tilted 15 deg and lifted 0.18 mm -
and all four export routes are pressed for real (**Export plate** and
**Download selected**, Format = STL and = 3MF, filename prompt accepted). Each
browser download is re-opened from disk with a parser that is not the app's
(a stdlib binary-STL reader; `nso-3mf-read.js` for 3MF) and compared vertex
for vertex, in order, against `p.geometry` pushed through `p.mesh.matrixWorld`
- what the viewport draws, not the `p.x / p.height / p.liftY` bookkeeping the
exporters read. Then every file goes back in through `handleFiles()` and the
new model's `rawTris` must equal the file soup, untranslated. Measured max
deviation on the plate routes: 8.4e-7 mm (STL) and 2.6e-6 mm (3MF, six-decimal
text); gate is 5e-5.

Conventions the suite pins, all read off the shipped code:
- scene `(x, y, z)` Y-up -> file `(x, -z, y)` Z-up; the scene rests a piece at
  y = 0.2 (`settlePlacedOnBed`), the file at z = 0, so `file_z = scene_y - 0.2`.
- the plate 3MF adds `(plate.w/2, plate.d/2)` for Bambu's front-left origin.
- **Download selected exports the MODEL, not the placed instance**: STL at the
  model's own centred origin, 3MF centred on the plate resting on z = 0. Yaw,
  tilt, lift and x/z are not carried on that route. This is by design (it is
  the list's selection, after Cut / Split edits) and the suite asserts it, so a
  change to the contract is a visible test change. If a user ever needs a
  posed single piece, that is **Export plate** with one piece on it.
- `addModel()` re-centres every import, so file placement survives only in
  `rawTris`. Recorded, not gated.

**`npm run fixtures:audit`** (`tools/fixture_audit.py`; `--gate --no-selfint`
in `npm test`, ~1 s). Every `.stl` under `fixtures/` and `library/`, three
checks: FORMAT (binary: declared triangle count gives exactly the file length,
count > 0, body not printable text - the Contents-API placeholder signature;
ASCII: facets present, three vertices each), CANONICAL (`mesh_validate.py`'s
own `validate()`, imported), and EULER (a surface closed by edge count with an
ODD characteristic is a vertex pinch - the 40921 bowtie that
`stl_watertight_check.py` passed - reported as PINCH). Only FORMAT gates:
`fixtures/repair/` and `fixtures/open/` are defective on purpose. Run it bare
for the full table with self-intersection, or `--root <checkout>` against
another branch. `mesh_validate.py`'s binary reader stops quietly at the end of
a short file, which is why FORMAT is a separate check and not a flag on it.

First run, 2026-09-16, `main` at 1315fc2 (51 files) and `claude-wip` at
a228ab0 (67 files): 0 FORMAT failures on either. Odd Euler on exactly the
three pinch fixtures (`synth_pinch_2sheet_safe`, `_tight`, `40921`), all
documented. Files that fail the canonical verdict and are NOT documented as
intentional: `fixtures/out-box-square-half.stl` (1 degenerate triangle) and,
in both `fixtures/` and `library/`, `hinge_knuckle_box` (234 piercing pairs),
`hinge_knuckle_lid` (124), `hinge_pip` (330, Euler 12 - several
separate shells), `lid_strap` (25, Euler 4), plus `library/box_closed` (74, Euler 4).
Those are multi-body STLs whose shells overlap; a slicer unions them, so they
print, but they are shipped in `library/` as product files and any CSG route
(Join, Subtract) will meet the overlaps. Resolved later the same day: the four
hinge / strap pairs are now real boolean unions of their shells (0 piercing,
`tools/nso_fixture_union.mjs`, numbers in `fixtures/README.md`);
`library/box_closed` is left as is and documented as not CSG-safe in
`library/README.md`, because the sculpt self-test and `docs/SCULPT-TIER1.md`
measure against its two-shell layout. The `skin_*_block` samples read
piercing pairs because their gap is exactly 0 and the checker has no
"touching along an edge" class (same as the Seat-gap 0 case). The tape files
are the documented CSG_INTEGRATION case.

## Grispr - per-object fan control (G-code post-process, NOT wired in)

`tools/grispr/grispr.py`, standalone Python 3, stdlib only. Full write-up:
`tools/grispr/README.md`. Suite: `npm run grispr:test` (82 tests, 16 synthetic
fixtures, plus 60 randomised layouts). Deliberately not in `npm test` - like
repair / sculpt / planar fuse it is unwired, and `npm test` is all-node today.

**NEXT CHECK - ANSWERED 2026-09-14, non-zero.** A real 2-object slice
(567,481 lines, 113 layers, objects 197 and 237) carries 336 balanced
`start/stop printing object` pairs, 113 layer manifests and 898 `M624`/`M625`
lines. The single-object file had none of those. So Bambu emits the labelling
machinery only for plates with more than one object, real multi-object plates
land in LABEL mode, and the inferred path only ever sees single-object files -
where per-object fan control is moot anyway. The write-refusal on multi-object
inferred files stays, as a guard against a shape that may not occur rather than
one expected to fire. Nothing had to be lifted: that refusal was always scoped
to `marker_mode == "object_id"`, so labelled multi-object writes were never
blocked.

Validated on that file: `--list` reads 336 blocks in label mode and flags true
interleave on essentially every layer. Targeting object 197 alone, object 237's
116 blocks spanning 389,156 lines show ZERO fan-state leaks, every one of the
567,482 original lines survives byte-identical and in order, and `--force`
reverts the 13.5 MB file byte-for-byte. First real-data proof of the no-leak
claim.

**It corrected a premise this module was built on.** The kickoff said fan state
is untouched at object transitions. It is not: 273 of that file's 335
transitions carry a fan command. Bambu wraps the layer-change/timelapse section
in `M106 S255` ... `M106 S<ambient>` with `M624`/`M625` masks around each block.
Those belong to the layer change, not to either object, so they sit between
blocks and Grispr leaves them alone - but they are one more thing overwriting a
forced value, which reinforces the --hold finding rather than softening it.

It is the advanced-mode companion to the baked cooling exporter, not an
alternative to it. The exporter owns the single-profile whole-plate case.
Grispr owns what the 3MF schema cannot express at all: per-object fan. It runs
as a Bambu Studio post-processing script (Others tab), so it depends on no
filament-preset state and cannot be dropped by "Discard Modified Value".

Two decisions that must not be "tidied up":

- **Boundary injection is the default.** Grispr injects at an object's start
  marker and restores at its stop marker, and leaves every `M106`/`M107` the
  slicer emitted INSIDE the object alone, because those include Bambu's native
  overhang/bridge forcing (`enable_overhang_bridge_fan`, already baked in by
  the exporter). `--hold` suppresses them and is opt-in precisely because it
  defeats that forcing. Do not make `--hold` the default.
- **The restore value is computed, never a constant.** At each stop marker it
  is the fan state the UNMODIFIED file would have had at that line. Objects
  interleave within a layer and an object can be re-entered on the same layer,
  so restoring to "the value before the block" would leak state into whoever
  prints next. Measured case, from the fixtures: object 2 raises the fan to
  S255 for an overhang mid-block, object 3 then prints on the same layer and
  correctly gets S255 back, not the S102 layer ambient.

Pass/fail is the leak invariant, not eyeballing injection points: for every
line outside a targeted object's block, the fan state in the output must equal
the original file's state at that same line. Checked line by line, every
fixture, every target combination, with and without `--hold`.

### Flagged at the 3MF exporter: `identify_id` is not written

`buildModelSettings()` in `nso-3mf.js` writes `<object id="N">`, a `name`
metadata, and a `model_instance` carrying `object_id`. It does not write
`identify_id`. `grep -rn identify_id` over this repo hits only this entry and
Grispr's own docs - no code writes it.

Grispr targets the G-code `unique label id`, which is Bambu's `identify_id` for
that object. So NSO controls the object ORDER it writes into the 3MF, not the
id Bambu stamps into the sliced G-code, and the chain

    NSO internal object -> 3MF identify_id -> G-code unique label id

is open at the first link. This does not block using Grispr - ids come from the
command line, read off `--list` - but it does block automating the hand-off.

Two ways to close it, exporter's call:

1. Write `identify_id` explicitly in `buildModelSettings()`. Only works if
   Bambu honours an incoming value on load instead of reassigning it.
2. Confirm empirically that Bambu's assignment is predictable from load order,
   then pin that as a documented assumption with a check behind it.

Either is a change to the exporter, not to Grispr, and neither has been tested.
The same real-Bambu-Studio session that verifies the baked cooling values can
settle it in one pass: export a 3-object plate, open it, slice it, and read the
`; start printing object, unique label id:` values back against the object
order NSO wrote.

### Real file, run 2026-09-14 - three defects found, all fixed

107,548 lines, 105 layers, one object (`; OBJECT_ID: 518`), stock Bambu PLA
Basic. Findings, in order of how much they mattered:

1. **The file has no start/stop object markers at all.** 105 `; OBJECT_ID: 518`
   comments, zero `start printing object` / `stop printing object`, zero
   `object ids of layer`. Grispr exited 3 and wrote nothing - correct
   fail-loud behaviour, but it could not read the file. It now has a second
   marker mode that infers block ends from `; OBJECT_ID:` / `; CHANGE_LAYER` /
   `; EXECUTABLE_BLOCK_END`. `--list` names which mode it used.
   Note the terminator is the layer change, NOT the timelapse block: the
   object's toolpath resumes after `; SKIPPABLE_END` and the sparse infill
   after it belongs to the object.
2. **The last inferred block swallowed the end gcode**, which contains
   `M106 S0 ; turn off fan` plus the P2/P3 shutdowns. Under `--hold` those
   would have been commented out and the fan left running after the print.
   Inferred blocks are now clamped to the file's last extruding move, which
   fixes it without depending on any comment.
3. **Fan speeds are fractional** - `M106 S196.35` appears 1222 times - and the
   file never uses `M107`, it writes `M106 S0`. Restores were rounding to int
   and could introduce an `M107` the file never used. Both fixed.

The measured number that matters for the module's story:

    105 block(s) across 1 object(s); 105 forced, 23 restored, 5694 suppressed

5694 of the file's 5735 fan commands sit INSIDE object blocks - about 54 per
layer, mostly overhang forcing driving `M106 S255` (2856 occurrences). So
boundary injection, the default, is overridden within a few lines on real
Bambu output. `--hold` is the only mode that does anything lasting on a file
like this. That is measured, not estimated, and it is the opposite of what the
default implies - see limitation 2 in `tools/grispr/README.md`.

Verification on the real file: full `--hold` run, output re-parses to the same
105 blocks, `--force` reverts byte-for-byte to the original (5823 lines
undone), end-gcode fan shutdown still executable.

### Still open on the real-file front

That plate was SINGLE object. Closed by the 2-object slice - see NEXT CHECK at
the top of this entry. The `exclude_object = 1` with no start/stop markers and
no `M624`/`M625` was the tell, and it held.

Grispr refuses to WRITE to an inferred-mode file with more than one distinct
object id, because the block-end guess is verified for the single-object shape
only. `--list` still works on it.

### The original pending note, kept for the record

`--list` had never been run on a real sliced file before 2026-09-14. The marker pattern is
confirmed against genuine Bambu output; Grispr's parser against that pattern is
not. Next slice off either printer:

    python3 tools/grispr/grispr.py --list /path/to/plate_1.gcode

Ping-pong analogue to the bare STL drop: a bare `.gcode` drop, no text, means
"run `--list` on this". Expect the block table; a parse error or an obviously
wrong block count IS the finding. Safe to run on anything - `--list` never
writes, and Grispr exits non-zero without touching the file on any pattern it
does not recognise, rather than reporting a zero-edit success.

## CI - GitHub Actions runs `npm test` on every push

`.github/workflows/test.yml`. Triggers: every PR into `main`, every push to
`main` or `claude-wip`, plus `workflow_dispatch`. The job is named **npm test**,
so that is the status-check name to tick in branch protection.

It runs `npm test` as one step rather than listing the suites in YAML, so CI
cannot drift from package.json. Add a suite to the `test` script and CI runs it;
nothing to change in the workflow.

**THE WORKFLOW FILE MUST EXIST ON `main`.** Learned the hard way on 2026-09-15,
and it is invisible if you do not know it. For a `pull_request` event GitHub
reads workflow definitions from the PR's MERGE REF - base merged with head - not
from wherever the file happens to live. While `test.yml` was only on
`claude-wip`, PRs into `main` queued NO run at all: not a failure, not an error,
no entry in the Actions list to find. The required check simply sat on "Expected
- waiting for status to be reported" forever and blocked every merge into main.
Searching Actions for the branch returns nothing, because nothing was ever
created. A branch may carry a newer copy, but `main` must always have one.

Corollary, and the reason a PR can fix this at all: a workflow added in a
same-repo PR IS in that PR's merge ref, so such a PR runs its own check and
bootstraps itself out of the deadlock. PR #46 did exactly that.

**The workflow deliberately does not list the suites or their check counts.**
It used to. The inventory drifted within a single day - the commit that added
`3mf:import` and `3mf:import-drive` to the `test` chain updated the comment's
total but not its table, so the file shipped claiming nine suites when
package.json ran eleven. package.json's `test` script is the one definition;
read it there. The check NAME is what branch protection pins, and that stays
`npm test` however the suite grows. The copy on `main` and the copy on
`claude-wip` are byte-identical, deliberately, so they cannot conflict on merge.

As of 2026-09-18 `nso_wire_extract_sel_test.js` is in that chain too, for
Extract selection, through the same harness as the rest of the wire-* set. It
targets through the app's own select-paint hit path, clicks the real button,
runs `NSO_edgeStats` on what lands on the plate, and hashes the source piece
either side of the extraction so "the original is untouched" is measured rather
than asserted.

One gate in it is worth keeping when that file is next edited: the shell
builder is called DIRECTLY with a patch that turns a corner, because the SELECT
list holds one face and the UI cannot aim that case. It is not padding - it is
the gate that caught the mitre reading 1227.2mm^3 where the answer is 931.2,
from area-weighting vertex normals by triangle instead of by distinct face
direction. Every UI-reachable case passed while that was wrong, because a
single flat face has one normal and cannot tell the two apart. A feature whose
UI can only reach the easy half of its own maths needs the other half called by
hand, or the bug ships green.

As of 2026-09-15 the wire-* trio is IN `npm test`, so Smooth, Seal->Repair and
Join->Fusion are gated by CI rather than only checked by hand. They run through
`tools/nso_app_harness.js`, not `cth-test/browser-lib.mjs`: that harness resolves
Chromium itself in `chromiumPath()`, which probes `/opt/pw-browsers` and returns
`undefined` on a runner, so Playwright falls through to its own pinned build.
Checked, not assumed. They also exit `fails === 0 ? 0 : 1`, which is what makes
appending them to the `&&` chain an actual gate rather than decoration.

Still NOT in CI, because still not in `npm test`: `grispr:test` (Python) and the
suites for modules that remain unwired - `nso_inside_corners_test.js`,
`nso_paint_scope_test.js`, `nso_repair_regress.js`, `nso_fuse_*_test.js`,
`sculpt_selftest.js`. Deliberate. Add to the `test` script to gate them; the
workflow needs no change.

**`npm test` needs python3, not just Node and Chromium.** `selfint:equiv` spawns
`python3` per fixture - it is the only thing keeping `tools/mesh_validate.py` and
the transcription in `NSO_Repair.js` from drifting apart again, which is how
three copies of that checker came to exist. There is no `setup-python` step:
ubuntu-latest ships Python 3 on PATH and the green runs are the evidence. If a
runner image ever drops it, this is the suite that breaks first, and the fix is a
`setup-python` step in the workflow, not a change to the test.

**No CHROME_PATH here either.** `npx playwright install` fetches the exact
revision the pinned Playwright wants (`chromium_headless_shell` v1194 for
`playwright` 1.56.1) and CI has the outbound access to do it. The web sandbox
does not, which is why the pin is matched to the build that is already on that
box - see the 3MF checks section above. Neither path sets `CHROME_PATH`.

**A runner DOES have outbound network.** Measured 2026-09-15, not assumed:
`cdn.jsdelivr.net` returns 200 for the manifold js (74762 B), the manifold wasm
(541470 B) and three.min.js (607784 B). So CI *could* use the CDN. It does not:
`browser-lib.mjs` serves `vendor/manifold/` and the `three` devDependency, and
`drive-check.mjs` asserts the substitution happened, so the hermetic path is the
tested path and a CDN outage cannot redden the build. The vendored sizes match
the CDN's byte for byte, so the copy is not a stale fork.

Cost on ubuntu-latest: see the commit that added the wire-* suites for the
current figure. Before them it was **42s green** (checkout 2s, node 1s,
`npm ci` 2s, playwright chromium 24s / 114 MiB, `npm test` 10s); the three wire
suites add roughly 14s of browser time. Red is faster, since `npm test` stops at
the first failing suite. No browser cache step - it saves ~20s and adds a
failure mode.

**Negative-controlled, not assumed.** Branch `ci-selftest-negative`, two runs
differing by exactly one line - an off-by-one in `app-mask.js` `nsoMaskCount()`:

    run 1  FAILURE  cth:unit ALL GREEN, then cth:capture 26/27,
                    "FAILED the face was painted (expected 1, got 0)", exit 1
    run 2  SUCCESS  same runner, same workflow, regression removed

`cth:unit` passing first in the red run is what makes it meaningful: a real
browser launched and a real page ran, so the red came from the app, not from a
broken setup. Branch deleted after; the pair is recorded here.

**Still to do by a human with admin rights:** making it merge-blocking needs
Settings -> Branches -> branch protection rule on `main` -> "Require status
checks to pass before merging" -> tick **npm test**. Not doable over the API
with this connector's permissions.

## CTH checks
`npm run cth:unit` is the dependency-free suite (`tools/cth-test/*.test.mjs`,
also runnable as `./tools/cth-test/run-all.sh`). `npm run cth:capture` and
`npm run cth:drive` drive the real app in headless Chromium and need `npm ci`.
`npm test` runs these three, the two 3MF checks and the three wire-* checks -
eight suites, 311 checks - and is what CI runs. Both browser checks serve three and the manifold
kernel from the `three` devDependency and `vendor/manifold/` rather than the
CDN `index.html` names, so they need no network.

## library/CTH_fixture.stl is the drive's INPUT, not its output
It was, for a while, its output. The file carried 1372 triangles, 94% of them
not axis-aligned - a box hull that had already been wrapped. `?cth=drive`
could not run on it: `nsoWrapAllReady` needs `rawBoxPockets() > 0`, a wrapped
piece is no longer a box pocket brick, so the Soften press ARMED instead of
baking and the drive reported `DRIVE FAIL (armed)`. Proof it was the drive's
own output: running the drive on `box_hull_80x40x20-2.stl` emits
"(1372 tris, one bake from source)" - the same 1372.

It is now a copy of `box_hull_80x40x20-2.stl`: 28 triangles, same
80x40x20 bbox, one pocket, a clean brick. Do not save a baked result over it
again. `npm run cth:drive` fails loudly if anyone does.

## Parked ticket - re-vendor cth/ from click-test
`cth/` is a vendored fork of `nolongerzzz/click-test` `src/`, and it has
drifted: 55-278 changed lines per file. Two regressions have already been
traced to the vendoring rather than to upstream - `escapeHtml` had its entity
map HTML-decoded, so only the apostrophe was escaped, and the overlay lost
upstream's always-a-list `renderAims()`. Both are fixed here now; the overlay's
completion-only summary is a deliberate divergence for the corner card, not
drift, and should stay.

Do NOT blanket-overwrite `cth/` from upstream. Some of the drift is intentional
nest-specific work. This needs a deliberate file-by-file review deciding, for
each hunk, whether it is a nest change to keep or vendoring damage to drop.

## Archive — Soften Corners second pass (corners2), historical

corners1 was measured on the exported STL of the live FAIL. What it actually
built, on the 12.38 x 20 x 20 baked half at R=2.5:

- All FOUR cap-loop corners carried an arc of exactly radius 2.5 (tangent at
  7.5 on each edge, centres at (+/-7.5, +/-7.5)). Watertight, 0 open, 0
  non-manifold. So "one pair only" is not in the mesh — but the shape was
  still wrong, in two ways that explain what it looked like:
- **Orbit-point.** The corner surface converged radially on the ORIGINAL
  sharp apex at depth 1.0355 — every rollover sample ran to one vertex, so
  the corner is a cone apex, not a fillet. From any camera off the face
  normal it reads as a point.
- **Bite too small.** corners1 rounded the lid boundary in plan with radius
  R but only cut the wall back by R/sin(45) - R = 0.4142 R. At R=2.5 that is
  a 1.04mm bite where 2.5mm was asked.

corners2 put Corners back through `rawEdgeRoundInPlace`. That work is already
on main as later corners tickets. Do not re-open it from this archive.

### Known, not current
`branch point in cap boundary` still refuses some cut faces (parked
`stash@{0}`) — Round, Bevel and Corners all refuse there identically.
`stash@{0}` stays parked until an explicit **APPLY**.

## Plate reference grid + grid-snap (landed, `app-core.js`)

Full write-up with numbers: `docs/PLATE-GRID.md`. Suite: `npm run grid:plate`
(`tools/nso_plate_grid_test.js`), added to the `test` chain so CI gates it.
Branch: `claude-wip-plate-grid`. No `?v=` tag bumped — Grok owns those.

A flat, world-aligned grid owned by the build plate, plus an optional soft snap
on the same lattice. Controls in the Plate card: `#plate-grid-show`
(auto / on / off, default auto) and `#chk-plate-grid-snap` (default off).

Three things the next ticket should not re-derive:

1. **Two grids now, and they are different features.** The surface grid
   (`app-seat-grid.js`, `b0dc10d`) draws on the Join/Seat target piece; this one
   is the bed. At the tip this branched from (`2a6d07a`) the surface grid did
   not exist, so the audit found no pattern to copy and the modes here were
   designed from the ticket; it landed in parallel and the two converged anyway
   — both carry `['auto','on','off']` and both kill picking with a `raycast`
   no-op. Naming is what the merge had to settle: `state.seatGridMode` and
   `#btn-seat-grid` for the surface grid, `state.plateGridMode` /
   `state.plateGridSnap` and `#plate-grid-show` / `#chk-plate-grid-snap` for the
   plate. Suites: `grid:math` + `grid:wire` are the surface grid's,
   `grid:plate` (`tools/nso_plate_grid_test.js`) is this one's. They share no
   code, and the surface grid was not touched.
2. **The old `plateGrid` was a `THREE.GridHelper` and is gone.** Same state
   slot, same name, same lifecycle in `buildPlateMesh` — but it was square at
   `max(w, d)` (overhanging a Prusa bed by 40 mm), had no round mm spacing to
   snap to (14.22 mm on an A1 256), and was a `hitPlateSurface` pick target.
   It is now an owned `Group` of two `LineSegments`, clipped to the real plate,
   on a 10 mm lattice, and removed from the pick list. `plateMesh` covers the
   same footprint so plate-drag orbit is unaffected.
3. **`PLATE_GRID_SNAP_STRENGTH` must stay below 1.** The snap maps the cursor offset
   `d` from the nearest line through `f(d) = R((1-S)u + Su²)`, `u = |d|/R`. The
   slope is `>= 1-S`, so `S < 1` is what makes the mapping strictly increasing —
   which is what makes this an assist you can always drag out of rather than a
   lock. At `S = 1` the slope at the line becomes 0 and it locks. The suite
   measures monotonicity on a real 41-sample drag sweep, so raising `S` to 1
   fails `npm test` rather than shipping a lock.

Paint: not applicable. The standing rule binds bake mechanisms; this draws lines
and moves a placement coordinate, and touches no triangle. Stated in
`docs/PLATE-GRID.md` §4 so the category question is answered once.

## Sculpt tier 1 — vertex adjacency + global smoothing (landed, `app-sculpt.js`)

Full write-up with numbers: `docs/SCULPT-TIER1.md`. Self-test:
`node tools/sculpt_selftest.js`. Script tag added to `index.html` at the
existing `?v=inside3` — tag NOT bumped.

State: both tiers built and measured. Topology invariance verified on every
fixture (same vertex count, triangle count, connectivity; only positions
move). Global Laplacian has no feature preservation and no way to protect a
region — that is the brush tier, and nothing in `app-sculpt.js` should grow
a feature term.

Three findings land on code this ticket did NOT touch. They matter for the
merge-order pass because each is someone else's gate:

1. ~~`NSO_weldEpsFor` (app-join.js) caps the weld tolerance at the strict
   minimum edge~~ — FIXED in weld-eps1. It now rejects the bottom 0.1% of
   edges that sit >=4x below the next edge up, so the tape's 2 slivers no
   longer pin the mesh: 4.997e-6 -> 4.2397e-5, and the part reads 0 open
   instead of 1402 (NSO_buildAdjacency) / 4 (NSO_edgeStats). All five call
   sites (2 in NSO_unionSoups, 2 in subtractSoupBFromA, 1 in
   joinSelectedModels) inherit it. 50 of 51 repo fixtures are bit-identical.
   `NSO_sculptWeldTol` stays for now — see docs/SCULPT-TIER1.md.
2. `NSO_edgeStats` and `rawCheckWatertightQuick` weld by coordinate
   rounding, so neither can see a backwards-wound face: it pairs every edge
   and reads 0 open while the volume is wrong. `NSO_buildAdjacency` counts
   directed edges (`stackedDirs`) and requires 0 for watertight. This is a
   second, distinct hole alongside the already-parked 208-odd-edge tolerance.
3. `tools/stl_watertight_check.py` rounds to 1e-5, too tight for a float32
   STL of an 82mm part: it reports 1406 false open edges on the tape fixture.

None of the three touched — each wants its own scoped pass and an APPLY.

## Inside corners — the corners8 setback in a pocket (landed, `nso_inside_corners.js`)

Full write-up with numbers: `docs/INSIDE-CORNERS.md`. Suite:
`node tools/nso_inside_corners_test.js` (101 checks). **Not wired in** — no
script tag, no `getEdgeTreat` option, `?v=` NOT bumped.

The ticket asked whether corners8's setback generalises to a concave pocket.
It does not, and the answer is measured, not argued: `softenSelectedFace`
refuses every internal face outright (`clicked face is not the outer plane on
that axis`); `rawVertexBallCorners` drops any corner whose turn opposes the
loop winding and then refuses the whole face; and the blend is subtractive and
two-edged — it closes on a point on the depth edge, which it leaves sharp.

It does not need to generalise. The pocket is cut by a **plug**, and a plug is
convex, so the unmodified engine runs on the plug's floor end and the existing
boolean mirrors it inward. No new geometry maths.

On the standard fixture at R=2: pocket-floor vertices fill **1.2779 mm**, floor
edges **0.8284 mm** (= R(√2−1), exact), vertical wall edges **0.0000**, lid rim
**0.0000**, +53.305 mm³, watertight, 0 self-intersections on
`tools/mesh_validate.py`. inside3's face reporting is unchanged on all six
paint cases, and the paint still drives geometry: painting the pocket wall
x=10 takes exactly its two floor vertices to 0.0000 and leaves the other two
at 0.6369.

**The mask6 both-faces rule was not touched.** The rim stays sharp by the
mechanism already shipping — the plug is pushed 2R+1 past its own mouth, so
only the floor end is treated.

Follows the standing paint rule at the top of this file: `opts.skip` is a
required argument, and painting the pocket floor or any of its four walls
stands the bake down and names the face. The status line is the shape the three
wired bakes adopted — `Pocket corners stood down - N painted face(s); …`,
matching `Smooth stood down - N painted face(s); …` and `Repair stood down -
N …` — and the result carries `painted` as the count with the detail under
`paintedFaces`.

One deliberate difference from that trio: Smooth / Repair / Fusion are
whole-piece operations with no skip list, so ANY paint on the piece stops them
(`nsoMaskCount(m) > 0`). This one knows which faces it touches, so it counts
only the pocket floor and its four walls. Paint on the pocket mouth, or
anywhere on the hull, does not stop it — this treatment never reaches those,
and the resulting bake still measures correct. A painted
wall stops the *whole* bake rather than leaving that one edge square, because
`rawVertexBallCorners` has no per-edge radius and its own rule is
all-four-corners-or-none; giving the setback a per-face radius the way
`rawWrapSolid` has one is a change to live corners8 code and wants its own
ticket and an APPLY.

Three findings land on code this ticket did NOT touch. Each is someone else's
gate and wants its own scoped pass and an APPLY:

1. `rawWrapSolid` has no setback branch — `mode === 'corners'` takes the ball
   path and everything else, **`cornersedges` included**, falls into the
   offset-of-the-shrunk-box branch. So in the whole-solid wrap, Corners+edges
   and Round are the same geometry on hull and pocket alike: identical tri
   count 3868, identical volume 21383.405746, identical probes. In the
   per-face path they are two different engines.
2. `rawVertexBallOnly` emits **72 inconsistently wound triangles** on a plug
   bake that `nsoSealScore` calls 0 open / 0 non-manifold; Manifold refuses it
   as a bare `Not manifold`. That is finding 2 above with a reproduction.
   `NSO_insideEdgeScore` counts directed edges and sees it.
3. `rawBoxPockets` groups faces by PLANE, not connectivity, so two pockets
   sharing any face plane merge into a non-box cluster and **both are
   dropped**. Two identical bays side by side at one depth → 0 found. Every
   face plane distinct → 2 found.

Also one-line and live: the setback's refusal message blames "something
already softened" for what is actually a concave corner.

## Seat with a gap (2026-09-16)
`app-join.js`, `NSO_seatFlushBitToHull` and two buttons in the Join card:
**Seat flush** (the plug seat, never reads the slider) and **Seat (support)**
with the gap **slider** `#seat-gap` (`-0.25 .. +0.05` mm by `0.01`, default
`-0.18`, mid easy-release) and its exact readout `#seat-gap-value`. Check:
`npm run seat:gap` (`tools/nso_seat_gap_test.js`, in `npm test`).

*History:* the gap first shipped as a number field beside a single Seat flush
button (blank = flush, number = gap). Split 2026-09-16 into the two buttons
above so the flush path can never be reached with a stale number in a field,
and the slider replaces typing: 0.01 steps sweep the plateau-to-weld boundary
(`-0.25` air .. `+0.05` overlap) without sub-hundredth noise. The bullets
below say "gap field" where they predate the split; read "slider".

**What Seat did before this.** It was never flush-only and it never had a
"gap". The core always took `opts.proud` (default 0.4): the distance the bit's
OUTER face - the one facing away from the hull - ends up outside the hull
skin. The button hardcoded `{ proud: 0.01 }`. So "Seat 0.01" on a real part
meant: bury the bit in the hull until its outer face stands 0.01 mm proud of
the skin, ready for Subtract to carve the pocket. Measured before the change
on `box_hull_80x40x20-2` + `box-20mm`: bit top 0.01 mm above the hull top,
bit bottom 19.99 mm below it. That is a plug seat, not a surface seat, and
`proud` is the wrong quantity for a breakaway piece.

**What changed.** A second, exclusive option: `{ gap: g }`. `g` positions the
bit's MATING face (the one facing the hull) off the skin, in the sign
convention `tools/breakaway_coupons.py` locked in its JSON
(`gap_overlap_mm`): **negative = air gap of that size, positive = the bit
penetrates the hull by that much, 0 = touching**. Easy release is
`{ gap: -0.18 }` (locked range -0.15 .. -0.20). Same corner rays, same tilt
fit, same translate along the fitted normal; only the reference face and the
sign differ. Passing `gap` together with `proud` or `lip` is refused. The
result carries `mode`, `gapAchieved`, `gapMin`, `gapMax` (coupon convention)
alongside the old keys. The flush path (`proud`) is byte-identical: the test
pins the pre-change pose to 1e-9 and the status line to the character.

**The buttons.** Seat flush = the old flush seat, unchanged (status
`Seated - proud 0.01mm ...`), whatever the slider shows - the test drags the
slider to +0.05 and clicks it, golden pose to 1e-9. Seat (support) = gap seat
at the slider's value, status
`Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`; the
measured value keeps its sign so a wrong-way seat can never read as right.
The slider is the control; arrow keys step 0.01, the readout shows the exact
value the next click will use, and a value set from code outside the range
clamps (the browser's own range sanitisation) so the readout and the seat
can never disagree. Seat (support) with the slider missing refuses.

**Two things the gap path does that the flush path does not.**
1. It settles the hull onto the bed baseline first (`settlePlacedOnBed`, what
   Align edges already does via `matchPlacedBottoms`). A dropped, never-moved
   piece sits 0.1 mm higher than a settled one, and `liftY` - what the exports
   write - is measured from the settled baseline. Left alone, that 0.1 mm
   would have landed in the exported gap; the whole easy-release window is
   0.05 mm wide.
2. Both plate exports (`buildCombinedGeometry` for STL, `buildPlacedObjects3MF`
   for 3MF in `app-core.js`) now add `liftY` to the piece's height. Before,
   every piece exported resting on z = 0 whatever the scene showed, so a
   seated gap - or any Lift - was silently dropped from the file the slicer
   gets. An unlifted piece exports exactly as before (the 3MF drive check's
   "rests on z = 0" gate still holds).

**Validation numbers (gap -0.18, real button, real export, canonical checker
`tools/mesh_validate.py --json`).** Scene: mating face +0.180001 mm above the
skin (the 7.6e-7 is the hull's Float32 soup). Export: 40 triangles, 0 open,
0 non-manifold edges, volume 71360.000 = hull 63360 + bit 8000, 0 piercing
pairs, 0 coplanar pairs, bbox height 40.18; the two shells split off the STL
are 0.1800003 mm apart; 3MF objects the same. Controls: +0.05 puts the
mating face 0.05 mm inside the hull, the checker sees 10 piercing pairs and
bbox height 39.95; 0 puts it on the skin to 7.6e-7 and the checker sees 4
coplanar contact pairs, which an air gap never produces.

**Known limits.** The plug frame picks the punch axis from the hull, so the
bit must sit roughly over the target face (Center X / Z first). On a curved
hull the seat tilts the bit through `mesh.quaternion`, which the export
transform chain (rotY / tip / roll) does not carry - a flat target is exact,
a tilted gap seat exports untilted. The two-shell touching case (gap 0)
reads as piercing pairs in `mesh_validate.py` because the checker has no
"touching along an edge" class; it is the coplanar count that separates
touching from an air gap.

## Contact skin on a face + Seat against the skin's tips (2026-09-16)
`nso_skin.js` (pure geometry, browser + Node), `app-skin.js` (the **Skin face**
button and pattern select in the Join card), `NSO_seatFlushBitToHull` gap mode
in `app-join.js` (tips reference). Samples: `fixtures/skin-samples/`
(`npm run skin:samples` regenerates, the test fails on drift). Check:
`npm run skin:test` (`tools/nso_skin_test.js`, in `npm test`).

**Audit before building.** Nest had no way to put a pattern on an existing
face. What existed: the sibling branch `claude/breakaway-coupon-*` builds
`ring` / `grid` anchor tips as their own closed shells sunk 0.2 mm into a
coupon body (`tools/breakaway_coupons.py` + `tools/meshlib.py`, volumetric
overlap, never on `claude-wip`); the app's bakes (Soften, Smooth, Repair,
Solidify, Thicken, inside corners) reshape a piece but none add relief to a
face. `nso_mesh_triangulator.js` and `skin_join_test.stl`, referred to in the
ticket, exist on no branch of this repository. So this is new, written to
the house shape: one pure module, one wiring file, one harness test.

**What Skin face does.** Picks the planar face of A whose normal best matches
a direction (toward B in a Join session, else +Z / top), outermost if several
are parallel; requires its boundary to be a rectangle. Removes that face,
builds the relief over the same rectangle with the original loop as its
perimeter, and re-fans every wall triangle that borders the face so each new
perimeter vertex is shared - one closed shell, Euler 2, 0 piercing on every
pattern, volumes match the analytic relief volume to 1e-3 (test part 1).
Patterns: `crosshatch` (ribs both ways, 0.42 wide, 1.2 pitch, 0.6 tall - the
fine mesh; the v8_FINAL printed interface is not in the repo as geometry, so
these are stated defaults, all parameters), `zigzag` (sawtooth-section
ridges, 0.42 crests, 2.0 pitch), `ring` (the coupon anchor tip, r 5, wall
0.8 -> 0.4, 1.0 tall). `mode: 'recess'` cuts the valleys down instead and
keeps a rim at the margin (needs margin > 0; ring is raise-only). Undo type
`skinReplace`. **PAINT SCOPE: sub-region** - only the face being skinned is
checked (`nsoMaskIsExcludedRaw` with the picked plane, axis and side when
axis-aligned); paint on any other face does not block, and those faces are
untouched by construction. A painted target face stands it down by name.

**The two surfaces, and which one Seat measures.** A skinned face has a base
plane (the floor between features) and a tips plane (rib tops / crests /
ring top, `height` above the base). The four corner rays Seat has always
cast land on whichever is under each corner - on the sample pairing all four
land in valleys - so a gap measured that way would seat B `height` deep in
the relief and print a solid fuse. Gap mode now probes first:
`NSO_Skin.supportExtreme` takes the hull's outermost point along the bit's
normal over the bit's FOOTPRINT (every hull triangle clipped to it, so a rib
whose end vertices lie outside the footprint still counts where it passes
under B), and compares it with the corner-ray plane. Rise > 0.01 mm
(`NSO_SEAT_TIPS_TOL`; a relief is a printed layer or more, a flat Float32
face measures ~1e-6) means a skin: B is translated along its own normal so
its mating face sits `gap` off the TIPS, untilted, and the result carries
`reference: 'tips'`, `tipRise`. A flat hull takes the corner-ray path
unchanged - `tools/nso_seat_gap_test.js`'s golden pose still holds to 1e-9 -
and reports `reference: 'plane'`. The status line appends
`- from skin tips, relief 0.60mm above the base plane`, so a seat that
measured from the wrong surface can never read the same as one that did not.
Limit: tips mode assumes B's mating face is parallel to the skinned face
(Center X/Z, upright); it does not tilt-fit a skin.

**Samples** (`fixtures/skin-samples/`, Z up, mm): A 30 x 30 x 8 on z = 0,
skinned on +Z; B 20 x 20 x 6 centred, underside on the tips (gap 0). One
`_block.stl` per pattern holds both shells (split to objects in the slicer,
or import the `_A` / `_B` singles, which share coordinates);
`skin-samples.json` carries the numbers. Measured through
`tools/mesh_validate.py --json` (test part 2): A alone Euler 2, 0 piercing,
0 coplanar; A+B 0 open, 0 non-manifold, Euler 4, volume = A + B to 1e-6,
exactly two edge-connected shells, A's highest z == B's lowest z bit for bit
(zero penetration), that plane 0.6 (ring: 1.0) above the base plane, coplanar
contact seen. Contact under B: crosshatch 234.6 mm^2, zigzag 84.0, ring 11.55
(of a 400 mm^2 footprint). Controls: gap -0.05 -> 0 piercing, 0 coplanar,
shells 0.05 apart; +0.05 -> piercing. As with the Seat-gap check, gap 0 also
reads as piercing pairs in the checker because rib walls stand edge-on in
B's plane and it has no touching-along-an-edge class; the -0.05 control and
the exact z equality are what separate touching from penetration.

**Reachability (audited 2026-09-16, second pass).** Both are wired in the
live app, not only committed: `index.html` loads `nso_skin.js?v=skin1`
before `app-core.js` and `app-skin.js?v=skin1` after `app-join.js`; the Join
card carried `#btn-skin-face` + `#skin-pattern` (crosshatch / zigzag / ring)
- **moved to the Finish tab later the same day, under the paint row, see
"Face select"** - and, from the Seat-gap commit, `#seat-gap` (now a slider
under `#btn-seat-support`, see "Seat with a gap"). The
mirror workflow run for `7ed4821` succeeded and the `nest-wip` tree carries
the same `index.html` (README source SHA matches), so the preview site at
<https://nolongerzzz.github.io/nest-wip/> serves it once Pages finishes its
deploy. Nothing needed wiring.

**Drive check** (`npm run skin:drive`, `tools/nso_skin_drive_check.js`, in
`npm test`): the whole flow through the shipped controls, on the real
fixtures box_hull_80x40x20-2 (A) + box-20mm (B): file input, Start Join,
Pick A / Pick B via the slot buttons and the list rows, Raise x11, pattern
select, Skin face, `-0.18` typed into the gap field, Seat flush, Format = STL,
Export plate - and the browser's actual download through `mesh_validate.py`:
two shells 0.18 apart, hull 20.6 tall, 0 piercing, 0 coplanar, height 40.78.
Then Undo x2, ring, gap 0, Seat, Export: hull top == bit bottom, coplanar
contact, height 41. The one step that is not a click is moving B over A
(there is no button; a viewport drag calls `selectPlaced` + `nudgeSelected`,
which the check calls directly and labels as such). `APP_URL=<site>` points
the same check at a deployment; the harness serves the three.js CDN tags
locally either way. Not run against the preview site from the sandbox - its
egress policy blocks `github.io` - so that run is the user's, or a runner's.

**Through the real app** (test part 3): plain block A + box-20mm B, Seat 0 on
the flat A -> `reference 'plane'`; Skin face -> A's raw soup replaced, 8.6
tall, undo restores 12 tris; painted +Z stands down, paint on -Z does not;
sphere refused; Seat 0 on the skinned A -> B's underside on A's world top to
2e-6, hull height 8.6 (not 8), status names the tips, core `tipRise` 0.600,
`gapAchieved` 0; Seat -0.18 -> plate export 2 shells 0.18 apart, 0 piercing,
0 coplanar, height 28.78; Seat +0.05 -> 0.05 into the relief.

## Multi-piece plate export, checked piece by piece (2026-09-16)
`npm run export:multi` (`tools/nso_multi_export_check.js`, in `npm test`,
93 checks). The Seat-gap and Skin checks each prove one pair; this one puts
**five pieces in three independent states** on one plate through the shipped
controls and matches every exported shell to its scene piece:

- free: `box-20mm` loaded first and never touched, left where the drop put it;
- pair 1: `box_hull_80x40x20-2` + `box-20mm`, Seat (support) at -0.18;
- pair 2: `box_hull_80x40x20-2` + `box-20mm`, Skin face crosshatch, then
  Seat (support) at -0.05 (a different gap, so the two pairs cannot be
  confused in the file).

Real numbers, from the browser's actual downloads. STL through the canonical
checker `tools/mesh_validate.py --json`: 34,660 triangles (12 + 28 + 12 +
34,596 + 12, the sum of the five raw soups), 0 open, 0 non-manifold, Euler
10 (five closed shells), **0 piercing, 0 coplanar**, volume 151,728.834 =
the five raw soups to 2e-3 (2 hulls 63,360 + 3 boxes 8,000 + 1,008.834 mm³
of crosshatch relief). Split into edge-connected shells: exactly five; every
shell's X/Y extents equal the scene's world box **to 0.00e+0**, height
equal, bottom at the piece's `liftY` (0, 0, 20.18, 0, 20.650002), triangle
count and signed volume equal to the piece's own raw soup (the 34k-triangle
skinned hull lands 6e-4 mm³ off, float32). Pair gaps measured off the
shells: **0.180000** and **0.050001**; A2 20.6 tall, A1 20.0 (no skin leaked
across pairs); both bits inside their hull's footprint; smallest plan
separation between assemblies 5.000 mm, no overlap. The 3MF route: five
objects in plate order, same extents +90, gaps 0.180000 / 0.050002, every
vertex inside the 180 mm plate. Neither export moved anything in the scene
(every pose field and world box identical before and after), and a second
STL export after selecting every piece in turn is **byte-identical**
(1,733,084 bytes).

One number worth knowing, pinned rather than fixed: the scene draws a
settled piece 0.2 mm above the bed and a never-moved piece 0.3 mm above it
(`placeModelMovable`'s drop baseline vs `settlePlacedOnBed`); the export puts
both on z = 0. The 0.1 mm is in the viewport, not in the file. Seat already
settles A first for this reason ("Seat with a gap", above).

## Thicken in / out - one-sided planar offset (2026-09-16)

Live testing reported two things: the result of Thicken in / out was a
stepped "waffle", and Thicken in moved the outside face. Both reproduced
through the shipped buttons and the real download (open box `fixtures/
box_open.stl`, 60x40x25, 2 mm walls, open top; solid `box-20mm.stl`):

| piece, op, 1.5 mm | tris | asked | delivered | outer bbox | volume |
|---|---|---|---|---|---|
| open box, in | 68 -> 82,264 | cavity wall +1.5 | cavity wall -0.24 (thinner) | 60 -> 59.77 | 13632 -> 12104 |
| open box, out | 68 -> 90,808 | outer +1.5 | outer +1.64, cavity -1.76 | 60 -> 63.28 | 13632 -> 36789 |
| cube, in | 12 -> 33,708 | nothing | shrank 0.125 | 20 -> 19.88 | 8000 -> 7851 |
| cube, out | 12 -> 42,900 | +1.5 per side | +1.25 per side | 20 -> 22.5 | 8000 -> 11165 |

**Root cause (audit).** Thicken was a voxel dilate, not a surface offset:
rasterise into a grid capped at 110 cells per axis (pitch 0.375-0.59 mm on
these parts), flood-fill the grid border to label "exterior", grow the solid
N cells, throw the mesh away and emit a cube face per exposed voxel face.
The waffle is those cube faces; the offset is quantised to whole cells.

**Wrong-side leakage had two independent causes.** (1) Every face was
re-sampled, so the side that should be untouched was rewritten and shifted
by up to a cell - the outer face moved inward 0.12-0.23 mm on Thicken in,
and the solid cube lost 149 mm3 with nothing to thicken. (2) In/out was
decided by connectivity to the grid border, not by which side of the wall a
face is on. Any open cavity - the slot and cup shapes the code comment said
Thicken is for - read as "exterior", so Thicken in found no interior and
did nothing but the damage in (1), and Thicken out grew the cavity face too
(wall 2 mm -> 5.27 mm).

**Now** (`app-finish.js`, `_thickenOffsetSoup` and friends; header comment
carries the full rule). A face is OUTER when its plane supports the convex
hull, or is reached from one across creases shallower than 45 degrees (the
rest of a curve, a rounded edge, a knuckle's far side); everything else is
INNER. Thicken out moves the outer faces, Thicken in the inner ones, by the
intersection of offset planes at each vertex (exact up to three plane
directions, area-weighted normal push beyond that, minimum-norm on flat
faces and edges). Triangle count does not change; a held face whose
vertices touch no moving face is bit-identical. Refused, piece unchanged, no
undo pushed: no face on the asked side (Thicken in on a solid), a face that
would turn inside out (offset bigger than the feature), a rise in piercing
self-intersections (NSO_Repair's canonical count), or paint (whole-piece,
see the roster). Inner patches under 0.16 mm2 ride with the skin; slivers
(under 0.01 mm2 or thinner than 0.1 mm) get no inversion verdict, the
piercing gate still covers them. A pocket whose rim is rounded reads as
outside skin - Thicken in wants a sharp rim, which is what the box hulls
and bits have.

**Validated** (`npm run thicken:drive`, in `npm test`; every step a click,
every file the browser's download through `tools/mesh_validate.py`):
open box in 1.5 -> 68 tris, 0 open, 0 nm, Euler 2, 0 piercing, outer bbox
60x40x25 unchanged, cavity walls 2 -> 3.5, floor 2 -> 3.5, volume 22396.5
(= 60000 - 53*33*21.5); out 1.5 -> bbox 63x43x28, cavity 56 wide as before,
volume 26460. Cube out -> 23 mm, 12167. Tube (genus 1) in / out: bore or
skin only, the other within 3e-3. Sphere out 1.5 -> all 2208 vertices within
3e-4 of radius 11.5, volume ratio 1.52088 vs (11.5/10)^3. Inward-wound
`library/USB_bit.stl` still grows outward, winding kept. Hinge knuckle box:
1.5 refused (knuckle gaps), 0.3 in / out watertight with Euler -4 kept. The
tape (186 piercing pairs before anything is done to it): out 0.3 refused by
the piercing gate, in refused (rounded slot rims), download identical.
Offsets are now exact, not quantised: 1.5 asked is 1.5 delivered.

## Position lock (2026-09-16)
`app-poslock.js`, the **Lock position / Unlock position** button in the
viewport bar (`#btn-lock-pos`). Check: `npm run lock:test`
(`tools/nso_poslock_test.js`, in `npm test`, 74 checks).

**Audit first - nothing existed.** `grep -in lock` over the loaded scripts
hits three things, none a piece lock: app-ux.js's "Look locked" (the orbit
target, camera only), Join's "Lock faces (optional)" (`state.joinUseFaces`,
the face-pick mode), and `setCutAxisLock` (the cutter axis). The two
per-piece user-set flags that do exist are mask6's paint
(`m.faceMask.exclude`, app-mask.js) and the non-solid flag (`m.nonSolid`,
app-nonsolid.js): both live on the model object, both have one accessor,
an undo entry and a list tag. Nothing gated any move path: `startMoveDrag`
checked only `state.cutterOpen`; `nudgeSelected`, `liftSelected` and the six
pose functions checked only that a piece was selected. So this is built on
the non-solid shape, not on a new one.

**What it is.** `m.posLock` on the model (so it survives every bake that
swaps `p.mesh`), read through `nsoPosLocked(m)` / `nsoPosLockedPlaced(p)`,
set only by the button through `nsoPosLockSet`, undo type `posLockReplace`.
The gate is `nsoPosLockBlocks(p, verb)` at the top of the nine move paths in
app-core.js: `startMoveDrag`, `nudgeSelected`, `liftSelected`,
`rotateSelected`, `flipSelected`, `tipSelected`, `rollSelected`,
`bankSelected`, `tiltSelected`. Locked: the call returns, nothing moves, no
undo entry, status `Locked - drag refused on <name> - press Unlock position
to move it`. Indicator: `locked` tag on the list row, a teal edge outline
as a child of the mesh (re-attached by `nsoPosLockRefresh`, which
`renderModelList` and `updateAdjustUI` call, so a bake's new mesh gets it
back), the 15 move/pose toolbar buttons greyed while a locked piece is
selected, adjust-status `Locked #n`.

**What it deliberately does not block:** Seat flush, Seat (support), Center
X / Z, Align edges, Skin face, the library's seat-on-arrival, Undo. None
read the flag. Lock after Seat has placed the piece; Seat on a locked piece
still seats it, because the user pressed Seat. A clone of a locked piece is
a new model and starts unlocked. In-memory only, like the paint: not in the
STL or the 3MF.

**Validation, real interaction.** Playwright's mouse pressed on the locked
piece and pulled 80 px: every pose field and the world box unchanged, no
undo entry, no drag left armed, status names the refusal; the same gesture
unlocked moves it 29.773 mm and reports `Moved model #2` (the control), and
Undo puts it back to 1e-9. The nudge primitive, Raise/Lower and the six pose
functions each leave the locked piece unchanged and name the refusal; the
four arrow keys are a no-op (the app binds no nudge keys - pinned). Seat
(support) on a locked B: seated, liftY 20.18, 0.18 above A to 2e-6, still
locked. Skin face on a locked A: baked (28 -> 34,596 tris), x/z untouched,
lock and outline on the new mesh. Export with A and B locked, C free:
34,620 tris, 0 open, 0 non-manifold, Euler 6, 0 piercing, 0 coplanar, B
0.180000 above A's tips; the STL is **byte-identical** (1,731,084 bytes)
with nothing locked and again with everything locked.

## Face select - the target, next to the paint (2026-09-16)
`app-mask.js` (the second list and the second mode), `app-skin.js` (the one
consumer), `nso_skin.js` (`findFace` takes a plane), `index.html` / `styles.css`
(the Finish tab rows). Check: `npm run select:test`
(`tools/nso_face_select_test.js`, in `npm test`, 72 checks: 15 in Node on a
pocket block, the rest through the shipped controls in headless Chromium).

**Audit first (Task 1), what was found.**

- *Join's "Lock faces (optional)"* is a dead stub, not a mechanism.
  `#btn-join-faces` is in no `index.html`; `app-join.js` hides it if it ever
  appears; `state.joinUseFaces` is read in two places and written only to
  `false`. What Join actually does when a slot is armed is
  `capturePlanarFace(hit)` (app-finish.js): it refuses the top ("Click a
  side wall, not the top"), returns a DISPLAY-space wall (`axis` x|z, `sign`,
  `worldTris` for the cyan highlight) and parks it in `state.joinFaceA / B`
  - session state, dropped by Cancel Join, shown only in the slot label, and
  consumed by nothing else (grep). Three reasons it is not the base for a
  target face: wrong space (world/display, not the piece's raw plane), wrong
  scope (a session, not the piece), and it is a second face resolver next
  to `nsoFaceFromHit` - the "second mapping" the paint rule above forbids.
  It was left exactly as it is.
- *The reusable picker is the paint's.* `nsoFaceFromHit` (one answer to
  "which face"), `faceUnderCursor` for a curved patch, the entry shape
  `{n, d, axisIdx, keepMin, dispAxis, dispSign, dispPlane, inner}`, the
  overlay that lights faces by the axis / side / plane the click recorded,
  the click-ownership predicate `nsoMaskTakesClick`, and the `maskReplace`
  undo. The select is built on all of that, as a second list on the same
  object.
- *Skin's auto-pick* is direction only: `NSO_skinDirForModel` gives raw +Z
  outside a Join and the A-centre -> B-centre direction inside one, and
  `NSO_Skin.findFace(soup, dir)` takes the coplanar group within 30 degrees
  of it, best dot, then the OUTERMOST plane. So it could never name a pocket
  floor, and it had no input other than the direction. An explicit selection
  therefore **overrides** the auto-pick, it does not coexist with it: Skin
  takes exactly one face, the selection is that face when there is one, the
  direction pick is the fallback when there is none, and the status line
  says which (`target: selected target` / `auto-pick: faces B` /
  `auto-pick: top face`). Paint still wins over both: a target that is also
  excluded stands Skin down by name.

**Two flags, two questions (Task 2).** `m.faceMask` now carries
`exclude: []` (unchanged: any number of faces, yellow, every bake's skip
list, `nsoMaskIsExcludedRaw` / `nsoMaskFaceList` / `nsoMaskCount`) and
`select: []` (new: at most ONE face, pink `#f472b6` - the colour no other
per-piece marker uses - read through `nsoMaskSelected(m)`, count
`nsoMaskSelectCount`, membership `nsoMaskIsSelectedRaw`, consumed with
`nsoMaskSelectClear(m, {noUndo})`). Same entry shape, same pick, both stored
as planes so both survive a bake. A face may be on both lists; that is two
true answers, not a conflict. `nsoMaskSnapshot` returns `{exclude, select}`
and `nsoMaskRestore` takes that or the older bare exclude array, so every
existing undo entry and test still restores. `state.maskPaint` is now
`false | 'exclude' | 'select'` - truthy while either session is live, which
is all app-core's click routing ever asked.

**The paint row (Task 3)**, Finish tab: **Paint Selected** (`#btn-mask-select`)
/ **Paint Excluded** (`#btn-mask-paint`, the old Paint faces) / **Clear
paint** (`#btn-mask-clear`, now drops BOTH lists). Paint Selected is
single-target: a click on a face makes it the sole target, a click on another
face moves the target there (status says `replaces the Y+ face`), a click on
the current target clears it. Multi-select was not built: Skin is the only
consumer and takes one face; a consumer that needs more adds a list, not a
meaning. Each click is one `maskReplace` undo step.

**Moved into the Finish tab (Task 4)**, directly under the paint row: `Skin
face` + the pattern select (were on the Join card), and `Cap open faces` (was
on the Join card). All three are bound by id (`app-skin.js`,
`app-join.js` setupUI), so nothing was rewired. The one consumer that did
break was the tests: a control inside the Finish `<details>` is not visible
to Playwright's `page.click` until the menu is open, so
`tools/nso_app_harness.js` gained `openFinishMenu(page)` (clicks the
summary, idempotent) and the four suites that press Skin
(`nso_skin_test`, `nso_skin_drive_check`, `nso_poslock_test`,
`nso_multi_export_check`) call it first. The skin drive also asserts the
new placement (`.vp-finish #btn-skin-face`, none of the three left in
`#join-card`). The cth capture check drives paint through `#btn-mask-paint`
and `!!state.maskPaint`, both unchanged.

**Drive check (Task 5)**, `tools/nso_face_select_test.js`, through the
shipped controls, A = box_hull_80x40x20-2 with B = box-20mm BESIDE it on +X
so the auto-pick has a wrong answer to give:
- no target, Skin face -> `Skinned +X face ... target: auto-pick: faces B`,
  A's raw X 80 -> 80.6, Z stays 20. Undo.
- Paint Selected, a real `mouse.click` on A's top in the viewport (the aim
  is asserted first: the app's own ray from that client point lands on that
  piece's Y+ face, and `elementFromPoint` is the canvas) -> one select entry,
  raw +Z at d = 10 (the fixture is centred), exclude list still 0, pink on
  2 tris, HUD `target Y+ face`. Skin face -> `Skinned +Z face ... target:
  selected target`, raw Z 20 -> 20.6 and **X stays 80** - the selected face
  got the relief, not the one that looks at B. Export plate: the downloaded
  STL's hull shell is 80 x 40 x 20.6, two shells, 0 open. Undo (button)
  puts back geometry AND target in one step (the commit's `prevMask`).
- one target at a time: +X replaces top, same face again deselects, undo of
  a select is its own step.
- paint wins: Paint Excluded on the same top -> both lists hold it, yellow
  and pink both drawn, Skin -> `Skin stood down - +Z face is painted`.
- Clear paint -> both lists empty; Skin falls back to the auto-pick (+X).
- an inner face: the Node part's 30x30x10 block with a 20x20x5 pocket is
  written to disk and loaded through the file input; a click on the pocket
  FLOOR records `inner: true, d = 5`; Skin face skins the floor, height stays
  10, status `Skinned inner +Z face`. With no target the auto-pick finds the
  rim and refuses it (not a rectangle) - the same piece Skin could not touch
  before.
- Cap open faces from its new row answers `No open face to cap` on the hull.

Known limits, stated not solved: the overlays draw for the ACTIVE piece
only (as the yellow always did), so a target painted on a non-active piece
is recorded but not lit until that piece is selected; the select is
in-memory like the paint, not in the STL or 3MF.

## Vertical stacking - Seat (support) from the bed, Align edges keeps the seat (2026-09-16)
`app-core.js` `matchPlacedBottoms`, `app-join.js` `NSO_raiseBuriedBitClear` /
`NSO_restoreRaisedBit` around the two Seat buttons. Check: `npm run seat:align`
(`tools/nso_seat_align_test.js`, in `npm test`, 51 gates). Live report: "Seat
(support) does not seat or magnet at all when stacking; Align edges sinks the
top piece to the plate when it sits above a support" (Join's Align was right).

**Audit - what actually happened, through the real app.** Both reproduced,
and they chain, but the causes are separate.

1. *Align sank the bit.* `matchPlacedBottoms` settled both pieces (which
   honours `liftY`) and then forced both world-box bottoms onto 0.2 outright.
   For a bit Seat had stacked at liftY 20.18 that put the mesh on the plate,
   inside the hull, while the record still said 20.18: the scene showed the
   bit sunk and the export still wrote it stacked. Align did not treat the bit
   as unpositioned and did not ignore the seat; only that last bed-squaring
   was wrong, and only for a lifted piece. Its XZ snap (edge flush with the
   hull's edge, "Aligned to A's inner wall") is the Join behaviour and stands.
2. *Seat (support) did not seat.* A part dragged over the support block rests
   on the bed inside it (drag never lifts). `NSO_plugFrame`'s exit probes read
   the open air BELOW the plate as clear of the hull, so for a part shorter
   than the hull it picked a downward seat; the core then said
   `... held at plate level: gap NOT as requested` and the part never moved.
   A part as tall as the hull happened to go up, but via the tips probe by
   accident (`from skin tips, relief 20.00mm` on a plain block). And after
   the old Align had sunk a stacked bit flush inside the hull, Seat failed
   with `corner 0 missed hull along punch axis` - the corner rays ran along
   the hull's own faces. That chain (Seat ok, Align sinks, Seat fails) is the
   "does not seat at all" in the report.

**Fix.** Two small, local changes; `NSO_seatFlushBitToHull` is untouched, so
`tools/nso_seat_gap_test.js`'s golden flush pose still holds to 1e-9.
- `matchPlacedBottoms` squares each piece onto `0.2 + liftY` instead of 0.2.
  An unlifted piece is bit-identical (0.2 + 0), so Join's Align and
  `joinHalvesOnPlate` see no change; a seated or Raised piece keeps its
  lift. Pinned: side-by-side Align lands on the pre-change box to 1e-9.
- Both Seat buttons call `NSO_raiseBuriedBitClear` first: a bit whose
  underside is below the hull's top while its XZ box lies inside the hull's
  (0.05 pad) is raised to 5 mm above the hull's top (liftY only - XZ and
  quaternion untouched) and seats from above, the pose the corner-ray fit is
  built for. Nothing can seat below the plate, so "down" was never an
  answer. The seat then measures its own liftY from the result as before.
  The undo entry is pushed before the raise; a failed seat puts the bit back
  exactly (`NSO_restoreRaisedBit`). A bit already above the hull, beside it,
  or overhanging its footprint is left alone - those paths are unchanged.

**Validation (real buttons, canonical checker).** Hull `box_hull_80x40x20-2`
+ bit `box-20mm`, bit dragged over the hull along the bed: Seat (support)
-0.18 -> `Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`,
underside 0.18 above the hull to 8e-7, liftY 20.18; Undo returns it to the
bed exactly. Align edges -> mesh y, liftY, box bottom and top `===` what Seat
left (30.380000762939453 / 20.180000762939454 / 20.380000762939453), the bit's
-Z edge flush with the hull's, X unchanged; Seat again and Align again do not
move it. Export after Align through `mesh_validate.py --json`: 40 triangles,
0 open, 0 non-manifold, volume 71360.000, 0 piercing, 0 coplanar, height
40.18, the two shells 0.1800003 apart, 3MF the same. -0.05 and 0 through the
slider each survive Align `===` (40.05 clean; 40.00 with coplanar contact).
Seat flush from the bed gives the golden plug relation and status. hinge_pip
(8 mm tall, the "held at plate level" case) seats 0.18 above the hull and
survives Align and a re-seat. Before the fix the same file fails 11 gates,
the two report lines verbatim among them.

**Known limits, stated not solved.**
- ~~Two pieces resting side by side on the bed never seat horizontally:
  `Seat failed - corner 0 missed hull along punch axis`.~~ **Fixed
  2026-09-17** - the ray origins are inset, see "Seating side by side" below.
  The reading here was right: both bottoms sit on the same bed baseline, so
  the corner rays ran along the hull's bottom edge and `NSO_rayTri` missed
  it; raising the bit by any amount already worked.
- A bit overhanging the hull's footprint is not raised and still fails on
  the overhanging corner, as before: the bit must sit over the target face.

## Skin wrap + the double skin (2026-09-16)
`nso_skin.js` (`applySkinWrap`, `opts.layer2`, and the seam fix the wrap
stands on), `app-skin.js` (`Skin wrap`, the layer-2 select, `Free`),
`app-nonsolid.js` (`opts.silent`), `app-core.js` (`pushUndo` snapshots the
non-solid flag), `index.html` / `styles.css` (the second skin row). Checks:
`npm run skin:wrap` (`tools/nso_skin_wrap_test.js`, 83 gates, every mesh
through `tools/mesh_validate.py`) and `npm run skin:wrap-drive`
(`tools/nso_skin_wrap_drive_check.js`, 38 gates through the shipped
controls), both in `npm test`.

**Audit first (Task 1), and what "wrap" turned out to mean.** Skin's scope
before this was exactly one face per press: `findFace` picks one coplanar
group, `rectFrame` requires its boundary to reduce to 4 corners at right
angles, and anything else is refused (`fixture_sphere_curved.stl` ->
`face is not a rectangle (3 corners)`). Nothing in the module iterated faces
and nothing handled a curved surface. **"Wrap" is not a new word in this
app**: Soften's `Full wrap` checkbox is "one click wraps all six faces of a
box. Off: one click bakes only the face you pick" (`index.html`,
`rawWrapSolid`, `wrapPocketsInPlace`), and the paint tooltip already says
faces are excluded "from Soften, wrap, Join and Skin". The ticket's own
example named a cylinder, so the two readings were put to the user rather
than guessed. **Answer: build the multi-face wrap now, write the curved one
up as the next ticket** - it was parked below and has since landed as
Texture.

**The defect the wrap stands on, found by measurement.** Skinning two faces
by calling the existing bake twice looked free, and was not. Two OPPOSITE
faces of `box-20mm` were always fine (no shared edge). Two ADJACENT faces
left **28 open edges, 28 non-manifold edges and 28 degenerate triangles** -
a closed piece turned into a broken one, silently, with Euler still 2. Two
independent causes, both fixed and both pinned by a gate:

1. *The seam's parameter epsilon was absolute.* `sideInsert` treated two
   params within `1e-9` as the same point. That held while a face was only
   ever skinned from exact corners; on a second face the soup it reads has
   been through `Float32Array`, so a param recomputed from a stored point
   differs from the exact one that placed it by ~1e-7 of the span. The same
   seam point then registered twice and the fan over it emitted a zero-length
   edge. The epsilon is now `tol / sideLength` - the same 1e-4 mm tolerance
   the rest of the seam uses, expressed in that side's parameter - and a
   chain collapses steps shorter than `tol`.
2. *The relief perimeter was never subdivided.* Wall triangles were re-fanned
   over the side's registered points; the relief's own perimeter was not, so
   where the second face's breaks did not land on the first's, every one was
   a T-junction. Invisible on a cube skinned with the same pattern twice
   (both faces break their shared edge at the same params - the "nothing
   inserted" gate), and **82 odd edges** with crosshatch on +Z and zigzag on
   +X. `fanRelief` runs the same pass over the relief: 25 triangles re-fanned
   on that pair, 115 on the hull with crosshatch on +Z and zigzag on +Y.

`fanTri` now handles a triangle with two or three split edges by splitting it
at its centroid first, so the corner cell where two skinned faces meet stays
paired. A triangle with no split edge keeps its old emission bit for bit,
which is why the whole existing single-face suite - including the
byte-identical sample STLs - passes untouched.

**What Skin wrap does.** `NSO_Skin.applySkinWrap(soup, opts)` takes
`faces: [{dir, plane?}] | 'box'` and skins them one after another on the
growing soup. Every face's plane is resolved UP FRONT on the original soup
and handed to each pick explicitly, so a pick can never drift onto something
an earlier face added. Refusal policy: strict by default - one refusal
returns the ORIGINAL soup with the reason and the face that gave it
(`the +Z face refused: face is not a rectangle (3 corners)`), never a
half-wrap. With `skipUnskinnable` (what the button passes) a face that has no
flat pick or is not a rectangle is left alone and NAMED, because the set the
wrap acts on is "the flat rectangular faces that are not painted out".

Measured, `box-20mm` wrapped crosshatch on all six faces: 25,308 triangles,
**0 open, 0 non-manifold, Euler 2, 0 piercing, 0 coplanar, 0 degenerate**,
volume 8,655.452 = cube + 6 x the single-face relief to 1e-3, bbox 21.2 on
every axis, contact 1,092.4 mm² (6 x 182.07). The hull
`box_hull_80x40x20-2` wraps 5 of 6 with the pocket face named and skipped
(`-X: face boundary is not a single loop`): 111,380 triangles, still one
closed shell. Recess wraps all six with the bbox unchanged. **PAINT SCOPE:
SUB-REGION, per face** - an excluded face is left alone and named, it does
not stand the wrap down; the SELECT target is a single-face idea and the
wrap says so when one is set.

**The double skin (Task 3), reported before it was built.** Applying two
skins in sequence is **not** achievable with this architecture, and the
refusal is the correct one rather than a gap: a skinned face is no longer a
face. `applySkinToFace` on its own output answers
`face boundary is not a single loop` - the tips are hundreds of separate rib
tops, not one rectangle - and naming the tips plane explicitly does not help.
Both are gates now. Two ways round it were put to the user, and **both were
built**:

- **Path A, composed (the default).** Two patterns in ONE pass over one
  merged grid, layer 2 riding on layer 1's tips:
  `h = h1 + (cell is a layer-1 tip ? h2 : 0)`. Composition happens in the
  height field, where both patterns are still plans. The result is **one
  closed shell** - Euler 2, 0 piercing - so nothing about the piece's closure
  changes and **no flag is involved**. Volume checks analytically for two
  flat-prism layers (cube + layer1 x h1 + composite x h2, 1e-3). Grid
  patterns only: `ring` builds its own surface and has no height field to
  compose, which is a named refusal pointing at the free layer instead.
  Raise only.
  *Honest limit, stated as a gate rather than left to be discovered:* the
  composite contact is the INTERSECTION of the two tip sets, so how much it
  shrinks is the second pattern's business. crosshatch + zigzag: 182.07 ->
  **52.41 mm² (28.8%)**. zigzag + zigzag: 53.76 -> 16.64 (31.0%). crosshatch
  + crosshatch at the stated layer-2 default: 152.08 (83.5%) - a crosshatch
  layer 2 mostly makes the relief taller, because its tips are the union of
  two rib directions and cover most of the face. Layer 2 at layer 1's OWN
  parameters lands exactly on layer 1's features and leaves the contact
  **bit for bit where it was** (182.07 -> 182.07). So the result carries
  `layer1TipArea` next to `tipArea` and the status line prints both:
  `contact 52.4mm² (layer 1 alone: 182.1mm²)`.
- **Path B, free (behind the `Free` checkbox).** Layer 2 as its OWN shell: a
  sheet resting on layer 1's tips carrying its own relief on top, a second
  breakaway interface, built as a slab and skinned through this same engine.
  The piece then carries two shells, **so the bake sets the non-solid flag on
  it** - the ticket's hypothesis, and it holds: this is the flag's own case
  (docs/NON-SOLID.md), a deliberate declaration that the piece is not meant
  to be a closed solid, made by the user asking for a free layer rather than
  inferred from the mesh. Measured on the cube: 7,720 triangles, 0 open, 0
  non-manifold, **Euler 4**, exactly two edge-connected shells, each closed
  and 0-piercing on its own, the sheet's underside equal to layer 1's tips
  **bit for bit** (zero penetration), volume = the skinned piece + the sheet
  + the sheet's relief to 1e-3. Control: `gap 0.3` -> 0 piercing, 0 coplanar,
  shells 0.300 apart. As with the Seat-gap and skin samples, gap 0 reads as
  piercing pairs in the checker because rib walls stand edge-on in the
  sheet's plane and it has no touching-along-an-edge class; the gap control
  and the exact equality are what separate touching from penetration.
  The sheet is inset to layer 1's margin by default, which is where layer 1's
  features stop anyway - and, found the hard way, keeps its side walls out of
  the piece's own face planes: flush with them they join those faces'
  coplanar groups and the next face pick sees two loops where it needs one.
  *Stated, not measured:* the sheet bridges from tip to tip, so its first
  layer prints over air.

**Undo carries the flag.** `pushUndo` (app-core.js) already snapshotted the
paint so a mesh swap and the paint on it are one step; it now snapshots
`nonSolid` for the same reason, and the geometry-replace branch puts it back.
One Undo after a free-layer skin returns the 12-triangle cube AND clears the
flag, checkbox and list tag together - a gate in the drive check.
`nsoNonSolidSet` gained `opts.silent` so the flag does not overwrite the
status line of the bake that set it; without it the skin's own line was wiped
and only "Flagged non-solid" remained.

**Reachability (audited 2026-09-16).** `index.html` carries `#btn-skin-wrap`,
`#skin-layer2` (off / zigzag / crosshatch / ring) and `#chk-skin-free` in a
second `.vp-row-skin` row in the **Finish tab**, under the existing Skin face
row; the script tags are bumped to `?v=skin2`. The drive check asserts all
three are in `.vp-finish`, that the wrap button carries its listener, and
that `NSO_Skin.applySkinWrap` and `NSO_skinWrapModel` are loaded.

**Drive check** (`npm run skin:wrap-drive`, in `npm test`): `box-20mm`
through the file input, the piece picked by clicking its list row, then -
Skin wrap -> `Wrapped 6 faces (+Z, -Z, +X, -X, +Y, -Y) ... contact 1092.4mm²
over all of them, 25308 tris`, scene 21.2 on every axis; Export plate (STL)
-> the browser's own download through `mesh_validate.py`: one edge-connected
shell, 0 open, 0 non-manifold, Euler 2, 0 piercing, 0 coplanar, 0 degenerate,
bbox 21.2³, 25,308 triangles. Undo -> 12 triangles. A painted +Z (set with
the app's own paint primitive - there is no button for a face click, and the
step is labelled as such) -> `Wrapped 5 faces (-Z, +X, -X, +Y, -Y) ... - left
painted: +Z`, the piece 20.6 tall in z and 21.2 in x and y, export still one
closed shell. layer 2 = zigzag, Skin face -> the status carries both contact
numbers, the piece is 20.9 tall, export one shell Euler 2. Free on -> status
names the free layer and the flag, checkbox and list tag both on, export: two
shells, Euler 4, the sheet resting on the tips to 1e-6, piece 20.6 tall and
the free layer 1.2. One Undo -> geometry and flag back together. No page
errors. `APP_URL=<site>` points the same check at a deployment.

### The OTHER wrap - Texture, a conformal skin on a curved face (LANDED 2026-09-18)
Was parked here as the follow-up when "wrap" was clarified. Built. Full
write-up with every number: `docs/CURVED-SKIN.md`. Files: `nso_skin_band.js`
and `app-texture.js` (both new), `index.html` / `styles.css` (a fourth
`.vp-row-skin` row in the Finish tab plus its two numbers), `app-core.js` (one
undo label), `tools/nso_texture_fixtures.js` and three committed cylinders.
Check: `npm run texture:test` (`tools/nso_texture_test.js`), in `npm test`.
`?v=` NOT bumped - the two new script tags ride the existing `?v=skin2`.

**Audit first (Task 1), and all three blockers were real.** The parked note
named plane-exact grouping, the rectangle requirement and single-normal
lifting. Each is demonstrated in part 1 of the suite rather than asserted:

- `findFace` on the cylinder's side returns **2 triangles, 29.44 mm² of 1885**
  - one facet of 64. "The side" is not a face that finder can name.
- the rectangle rule is **worse than a refusal**, and this is the one thing
  the parked note understated: a facet IS a rectangle. At the default pattern
  `applySkinToFace` refuses the cylinder for being too NARROW (`face too small
  for the crosshatch`), not for being curved - and at a fine enough pattern it
  **succeeds**, skinning one stripe of sixty-four (15.04 mm² of 1885). Silent,
  plausible, wrong. A user would have had to count ribs to notice.
- a relief lifted along one constant `N` reaches **20.6 mm** from the axis on
  the far side of an R 10 cylinder. The built article reaches **10.600000**,
  gated.

**Scope (Task 2): one curved primitive, a cylinder.** Not an arbitrary
developable band and not free-form. The axis is FITTED (area-weighted normal
covariance, all three eigenvectors tried), so a cylinder tipped 30°/20° and
moved anywhere is the same band - gated, r and D to 2e-3. Refused and named:
a sphere and the organic blob (`not a cylinder about this axis - the rim
points are off a circle by 2.39 / 4.33 mm`), a side tessellated into more than
one ring up the axis, and anything under 12 facets around. That floor is a
real boundary, not neatness: **a 20 mm cube passes every other test** about a
face axis, because its eight corners genuinely do lie on a cylinder of radius
r√2. Below it the refusal points at the engine that does cover the shape -
`a 4-sided prism, not a cylinder - its sides are flat rectangular faces, which
Skin wrap already covers one face at a time`. `fixtures/prism_r10h30_s8.stl`
is committed as that case. Raise only, and it says why.

**What was built (Task 3).** `NSO_Skin.patternPlan` is reused **unchanged**,
on a `planeFrame` whose W is the circumference and whose D is the axial
length - the rib intervals were always a 1D problem per axis. Two adapters
sit between it and the band, and they are the only places this touches the
pattern:

1. **The seam is not a margin.** A band has no edges in u, so a margin there
   is a bald stripe - the opposite of a wrap. The plan is built with
   `margin: 0` and the pitch is SNAPPED to an exact divisor of the
   circumference (`k = round(C / pitch)`, `pitch = C / k`). `ribIntervals`
   then leaves exactly half a gap at each end, so the wrap-around gap is one
   full `pitch - rib` and the layout is periodic. The snap is reported and the
   status line says it: 1.2 → 1.208305 mm over 52 repeats.
2. **The axial margin is the band engine's own**, as two rim rows at height 0.
   That is what keeps the relief's perimeter on the ORIGINAL rim loops, which
   is what lets the caps stay where they are.

`bandRelief` is `gridRelief` with two changes and nothing else: u wraps (node
column `nu` IS column 0 - no seam column, no duplicated ring), and every lift
takes the node's OWN radial normal, with a normal at each end of a wall. The
base is the original faceted surface, not an idealised cylinder, and
`breaksU` is merged with the band's facet angles so no rim vertex is skipped.
Cap triangles that own a piece of a rim are re-fanned (`fanCapTri`, which is
`fanTri` for a closed polyline).

**Validation (Task 5), all of it on a real exported binary STL read back off
disk and judged by `tools/mesh_validate.py`:**

- `cylinder_r10h30_s64` + crosshatch: **30,912 tris, 0 open, 0 non-manifold,
  0 odd, 0 inconsistent winding, Euler 2, 0 piercing, 0 coplanar, 0
  degenerate**, one edge-connected shell. Axial extent 30.00000 unchanged,
  radial 21.200001 = 2(R + depth), cap area unchanged to 1.6e-6 mm².
- **Conformal, measured:** every one of 54,720 tip vertices stands
  **0.6000000 mm off the ORIGINAL surface** (the inscribed prism, derived by
  the test, not asked of the engine) - worst error **4.6e-7 mm**. Max radius
  anywhere 10.600000 where a single-normal lift reads 20.6; min radius on the
  side 9.987977, the prism's own apothem, so the piece under the skin is
  untouched. 3,904 tip triangles straddle a facet edge - it is one surface
  over the band, not a tile per facet.
- **The wrap closes:** 104 rib-side walls for 52 repeats, every boundary one
  pitch from its partner **including across the seam** (worst 5.1e-7 rad),
  arc pitch on the file 1.208305 mm to 2.1e-9. The repeat count comes from
  the ARC (52); a planar diameter reading would have given 17, which is the
  failure mode the parked note said to look for.
- **Contact area, the number that is easy to get wrong:** measured
  **1057.882588 mm²** against a closed form of 1057.882648. The flat
  (unrolled) reading - exactly what the existing engine's `tipArea` would
  say - is **998.40, 6.0% low**, and the status line prints both:
  `contact 1058.3mm² on the curve (998.4mm² unrolled)`.
- **Volume:** +616.4094 mm³ against the curved closed form 617.0128 (0.098%);
  the FLAT form 599.0415 is 2.90% out, thirty times further. The curvature
  term is `m2 / 2r` with `m1 = ∫h`, `m2 = ∫h²`, both by 2×2 Gauss - not
  `area·h·(1 + h/2r)`, which overstates a sawtooth threefold. The 0.098%
  residual is the inscribed prism, and it is gated by refinement rather than
  argument: crosshatch 0.161 → 0.049 → 0.015 → 0.004% and zigzag 0.951 →
  0.704 → 0.398 → 0.135% over 48/96/192/384 facets.
- zigzag and a second cylinder (r 6 × 12, 96 facets) carry the same gates.

**Paint: SUB-REGION, the curved band.** A click on a cylinder's side records
ONE facet's plane, so the check is `nsoMaskIsExcludedRaw(m, face.n, face.d)`
over the band's distinct facet planes - mask6's own answer, per facet, never a
second mapping. ANY painted facet stands the whole bake down, because the
relief is periodic around the full circumference and the engine has no
per-facet height; skipping a painted facet would leave a bald stripe, which is
a different feature. A painted CAP does **not** stand it down - the caps keep
their planes and boundary loops and only get re-fanned, the same thing
`applySkinToFace` already does to the walls beside a skinned face. All three
behaviours are gated headlessly against a stubbed `nsoMaskIsExcludedRaw`.

**The name.** The button is **Texture**, deliberately not a third "wrap".
Soften's `Full wrap` checkbox is edge treatment on a box and is untouched;
`Skin wrap` is flat rectangular faces one at a time and still refuses a
cylinder. The suite gates that `#chk-full-wrap` is still there and still says
"Full wrap", and that nothing in the UI calls Texture a wrap.

**One defect found and fixed on the way** (in the new file, not the old one):
`wallBetween`'s quad emission assumes both ends of a wall have height. A
sawtooth flank starts at zero on every ridge, so one end is a POINT, and
emitting a quad there puts a zero-area triangle in the soup and uses one of
its edges three times - **124 odd and 124 non-manifold edges** on the zigzag
band, measured, until `wallBetween2` learned to emit a triangle. The flat
`gridRelief` reaches the equivalent branch 32 times on a 20 mm cube and comes
out clean, so this is not a report against `nso_skin.js`.

**Seat against a curved contact is OUT OF SCOPE (Task 4)** and is its own
ticket, dispatched separately. Nothing here answers it and nothing here calls
into it - gated: neither new file calls `supportExtreme`, `tipContactArea` or
any Seat entry point. The `tipArea` this bake reports is the tip-surface area,
not a promise that Seat can land a part on it.

That separate ticket has since **LANDED** - see "Seat here" below and
`docs/SEAT-SURFACE.md`. It took the second of the two options the parked note
put: Seat grew a second mode rather than the geometry staying on its own. It
is a NEW module and a NEW button; `NSO_seatFlushBitToHull` is byte-identical
and nothing above changed, so the gate in this paragraph still holds as
written and still should.

**Still open after this, each its own question** (in `docs/CURVED-SKIN.md` §9):
a second layer (composed would drop in; a free layer needs `freeLayerShell`
rewritten as a cylindrical shell), a cone or a torus, and several bands on one
piece - `findBand` reads the whole soup as one cylinder by design.

**Drive check** (`npm run texture:drive`, `tools/nso_texture_drive_check.js`,
in `npm test`): the same standard as `skin:wrap-drive`. The cylinder fixture
through the browser's own file input, the piece picked by clicking its list
row, then - Texture -> `Textured the curved side - crosshatch lattice ... 52
repeats around at 1.208 mm arc pitch, tips +0.60mm (pitch snapped 1.20 →
1.208mm so the wrap closes), contact 1058.3mm² on the curve (998.4mm²
unrolled), 30912 tris - caps untouched`, the scene 21.2 across where it was 20
and still 30 long. Export plate (STL) -> the browser's download through
`mesh_validate.py`: one edge-connected shell, 0 open, 0 non-manifold, 0 odd, 0
inconsistent winding, Euler 2, 0 piercing, 0 coplanar, 0 degenerate, 30,912
triangles, bbox 21.2 x 21.2 x 30 with the axial extent bit for bit what it was
before the bake.

**The engine suite's headline numbers are then re-measured on those downloaded
bytes**, against a band fitted to the plain cylinder exported from the same
session - so they are taken in the exported frame, not the builder's. Every one
of 54,720 tips stands **0.6 mm off the ORIGINAL curved surface to 4.5e-7 mm**;
max radius 10.60000 where a single-normal lift would read 20.6; the floor
between the ribs is still 9.98798, the prism's own apothem; and the contact
measures **1057.8826 mm²**, the engine suite's number to the fourth decimal.
That is the gate that says the button bakes and exports what the engine
proves, rather than something that merely looks similar.

Also driven: Undo -> 256 triangles and `Undo: Texture reverted`. A painted
SIDE facet (set with the app's own paint primitive - there is no button for a
face click, and the step is labelled as such) -> `Texture stood down - 1
painted facet(s) ...`, piece untouched at 256 triangles. A painted CAP instead
-> it textures anyway, with the paint still on the piece, which is the
sub-region rule driven through the shipped button rather than asserted in a
unit test. zigzag -> 1,900 triangles and one closed shell on export. The prism
fixture -> `Texture refused - ... an 8-sided prism, not a cylinder ... which
Skin wrap already covers one face at a time`, 32 triangles untouched. No page
errors. `APP_URL=<site>` points the same check at a deployment.

## Seat here - seating against a curved or irregular target (2026-09-18)
`nso_seat_surface.js` (new: the pure core, browser + Node),
`app-seat-surface.js` (new: the **Seat here** button, an armed click in the
Join card), `tools/nso_soup_distance.js` (new: the independent
minimum-distance checker), plus small additive changes to `app-core.js` (the
undo label, `prevPose` on the replace-undo branch, the click question),
`app-measure.js` and `app-carve.js` (disarm each other), `index.html`,
`styles.css`. Full write-up: `docs/SEAT-SURFACE.md`.

Checks: `npm run seat:curved-audit` (`tools/nso_seat_curved_audit.js`, Task
1's audit, exit 0 = every finding still holds), `npm run seat:surface`
(`tools/nso_seat_surface_test.js`, the gate), `npm run dist:selfcheck`. All
three in `npm test`. **This is the separate ticket the Texture section above
dispatched, and it answers the open question that note left open - what
`supportExtreme` and Seat mean against a curved contact. Of the two options it
offered, this is the second: Seat grew a second mode.** It is a new module and
a new button, so Texture's own gate ("neither new file calls supportExtreme,
tipContactArea or any Seat entry point") still holds, `nso_skin_band.js` and
`app-texture.js` are untouched, and a Texture band is still not offered as a
Seat target - this seat measures an interface between two pieces, and the
relief's tip surface is not one.

**Positioning only.** The SHAPE of the contact - a mating face cut to the
curve, a pad, a cup - is a separate later layer, and the boundary is measured
rather than waved at: see `docs/SEAT-SURFACE.md`, "Deferred: contact
geometry".

**Audit first, and the answer was BOTH.** The shipped seat casts four rays
from the corners of the bit's outer box face along one axis. A curved target
falls away from a flat footprint, so those corners overhang and the ray misses
- a 20 mm bit over the 20 mm sphere, a 12x8x8 bit 5 mm off the crown, anything
over the genus-1 groove and a 20 mm bit over the organic blob all refuse on
BOTH buttons with `corner N missed hull along punch axis`. Where the rays do
land, gap mode reaches the skin-tips branch and measures the right minimum -
but reports a bare sphere as `from skin tips, relief 3.11mm above the base
plane`, and writes a rotation of 0.0000 degrees, so the piece is never
oriented to the surface. `proud` mode has no tips probe at all: a rod on end
over the crown seats with a residual of 0.4754 mm against a requested 0.01.
And the footprint is the bit's BOX face, not its contact outline, so on the
blob a requested 0.18 mm air gap really measures 0.2053 (round rod: the square
over-reaches the circle) or 0.1737 (flat bit: the blob rises outside the
footprint) - both larger than the 0.05 mm easy-release window.

**The finding that decided the design.** `buildCombinedGeometry` rebuilds each
piece's rotation from the quantised pose fields and never reads
`mesh.quaternion`. Measured: a 0.3 rad tilt is 25.017 mm of scene height and
20.000 mm of exported height, every pose field still zero. So the shipped tilt
fit cannot be gated through the canonical checker at all - the file does not
carry what the screen shows. **Seat here therefore writes no free rotation.**
It rotates the piece's own raw soup by the delta in raw axes
(`Rx(+90) . Q_pose^-1 . delta . Q_pose . Rx(-90)`), commits through
`NSO_sculptCommitRaw` like every other bake, and re-fits x / z / liftY to the
world box the plan measured. That is Local-Carve's contained-pose-state
decision reached from the other side: the blade stays out of `state.placed`, a
seated piece cannot, so the pose model must never be handed anything it cannot
hold.

**What is reused, not rewritten.** `NSO_Carve.probeTarget` identifies the
feature at an arbitrary point (its dihedral merge is what reads a tessellated
dome as ONE face); `NSO_Skin.supportExtreme` measures a surface over a quad
footprint and is already orientation-agnostic; the gap sign convention and the
`#seat-gap` slider are the shipped ones - negative = air, positive =
penetration, 0 = touching.

**One thing probeTarget could not be used for.** Its outward direction is not
a tangent-accurate normal and cannot be: it buckets triangles within 5 degrees
and keeps the FIRST one's normal as the bucket's, so on a fine mesh the answer
depends on triangle order - up to 2.5 degrees off analytic on a 240x480
sphere, and no finer a mesh helps. Fine for a blade, not for a seat (2.5
degrees across a 12 mm footprint is 0.25 mm at the far edge). So the feature
comes from probeTarget and the NORMAL is measured next to it, as the true
area-weighted mean over the same neighbourhood: 0.0000-0.1825 degrees against
calculus, on a coarse mesh and a fine one alike.

**What "the gap" means, and it is solved not inferred.** `gap < 0`: the TRUE
MINIMUM DISTANCE between the two surfaces is `|gap|`. `gap = 0`: first
contact. `gap > 0`: `gap` mm past first contact. First contact is a separate,
bracketed solve because `dist(t) = 0` over a whole interval - inverting it as
if monotone is how a "touching" seat came out 0.14 mm clear and a "+0.05
overlap" 0.10 mm deep, both seen before the bracket went in. Where the contact
IS the footprint quad - every case the shipped seat was validated on - first
contact and the support plane are the same offset, so `gap` means exactly what
it meant before; where they differ, only the shape-dependent rule was ever
wrong. Measured payoff on the round rod over the blob, 16 aim points: the
support rule alone gives up to 0.6084 mm of real clearance for a requested
0.18; the solve gives 0.18000 at all sixteen.

**Two minimum-distance implementations, on purpose.** The core solves with its
own; the gates measure with `tools/nso_soup_distance.js`, stdlib-only with its
own self-check, and the suite asserts the two agree to 1e-9 on the real
fixtures. Same discipline as `tools/nso_selfint_equiv_test.js`. Both are exact
(9 edge/edge + 6 vertex/triangle, with contact tested separately), because
every Seat check before this one measured its gap as a box difference along one
axis - exact for two boxes, meaningless against a dome.

**Validation (real button, real curved fixtures, real export, canonical
checker).** Eleven aim points across the sphere (crown, equator, 45,
off-axis), the blob (top, side, off-axis) and the groove (ring top, outer
flank, dome at 45, and the CONCAVE inner wall), plus the flat block. Each:
scene clearance = the requested 0.18 to 2e-5; no free rotation on the mesh;
Export plate through `mesh_validate.py --json` with 0 open, 0 non-manifold, 0
piercing, 0 coplanar; and **the gap measured on the EXPORTED shells is 0.18 mm
to 5e-5**, 3MF the same - turns of 5.6, 23.4 and 44.5 degrees all coming out of
the file intact, which is the gate the shipped tilt fit could never pass. Euler
is asserted as the TARGET fixture's own plus the bit's 2, not a constant 4,
because `fixture_groove_concave` is genus 1. One Undo returns B to its imported
soup after every one of the eleven, so the bakes cannot stack. Plus the sign
convention through the button on the sphere's flank, ONE seat driven by a real
mouse click on the canvas, the paint stand-down and its converse, and four
app-level refusals.

**Regression: the flat-face seat is untouched.** `NSO_seatFlushBitToHull` is
byte-identical and `app-join.js` contains no reference to the new core - both
asserted. The golden flush pose (1e-9) and status line (byte for byte) and the
flat `-0.18` gap seat are re-pinned in the new suite as well as in
`tools/nso_seat_gap_test.js`, so a change to either has to fail two suites.
`seat:gap`, `seat:align`, `seat:overhang`, `seat:side` and `paint:scope` all
pass unchanged.

**Agreeing with the two threads that landed beside it.** Seat here writes the
seat record every Seat now leaves (`NSO_recordSeat`, app-join.js), so the 3MF
scene block carries its gap out to the file: `kind: 'support'`, `measured` in
the coupon sign, `reference: 'face'`, and no `residual` - there is no
corner-ray residual here and the normaliser reads a null as 0, so the key is
left absent. Gated on the piece AND through `buildPlateSceneJson`. And it
joins the one-armed-click-at-a-time rule both ways: arming it turns Center
lock's pick off, arming Center lock (or Paint, Carve, Measure) turns it off,
and `clearJoinSlots` retires it with the slot - silently, through
`nsoSeatHereDisarm`, because clicking the button there would print over the
caller's own status line. All gated.

**PAINT SCOPE: WHOLE-PIECE**, on the piece being seated, and only when the
seat has to turn it - the target is only ever read, and a seat that needs no
turn changes no geometry. A turn rewrites the whole soup in new axes, so no
sub-region survives as itself and whole-piece is the only coherent reading.
Reasoning in full: `docs/SEAT-SURFACE.md` §3.

**Known limits, stated not solved.**
- A flat face tangent to a sphere touches at ONE POINT and
  `mesh_validate.py` has no class for that, so a `gap 0` seat on a curve reads
  0 piercing / 0 coplanar exactly as an air gap does. The measured
  shell-to-shell distance (0.00000 vs 0.05000) and the piercing pairs at +0.05
  are what separate them, and the suite asserts both.
- The footprint is still the piece's box face. The solve makes that cost
  nothing in the SEPARATION; it still costs the contact-patch reporting, which
  is the deferred shape layer.
- A seat that would put the piece below the plate is refused rather than
  clamped. Clamping is what the gap seat does, and it is right there (the
  status says "gap NOT as requested"); here the whole point is that the gap is
  exact, so a pose that cannot deliver it is not offered.

## Crosshatch at a tighter pitch, and a double-sided patch (2026-09-18)
`nso_skin.js` (a `family` field on every `PATTERNS` entry, the `crosshatch-fine`
preset, `familyOf` exported, `crosshatchPlan` now publishes its rib intervals),
`nso_skin_patch.js` (the `sandwich` variant; every dispatch moved from the
pattern NAME to its family), `index.html` (the preset in two selects, the
variant in a third), `app-library.js` (ten patch rows in `CATALOG`),
`library/patch_*.stl` (ten files), `fixtures/skin-fine/skin-fine.json`,
`docs/SKIN-CROSSHATCH-PITCH.md`. Checks: `npm run skin:fine`
(`tools/nso_skin_fine_test.js`), `npm run skin:fine-fixtures`,
`npm run skin:fine-drive` (`tools/nso_skin_fine_drive_check.js`, every catalog
row through the real Library UI). All three are in `npm test`.

**The audit first (Task 1), and it has two halves.** `pitch` was ALREADY a
parameter - `PATTERNS.crosshatch.defaults.pitch`, merged by `withDefaults`,
read by `crosshatchPlan` into `ribIntervals`. Nothing was hardcoded, and
`buildPatch({ params: { pitch: 0.84 } })` has always worked. **But it could not
be reached from the app**: `#skin-pattern` is a name-only select and no caller
in `app-skin.js` or `app-skin-patch.js` has ever passed `params`, so from the
app's seat 1.2 was the only pitch there was. The gap was REACHABILITY, not
parameterisation, which is why a named preset is the whole fix.

**The canonical checker cannot answer the printability question, and that is
worth knowing before the next person trusts a green run.** `mesh_validate.py`'s
wall check rays along the INWARD normal, into the material, so on a rib's side
wall it measures the rib and stops - the open channel to the next rib is on the
other side of that face and no ray goes there. Measured: a crosshatch at 0.5 mm
pitch, whose channel is **0.08 mm**, passes `--gate --non-solid` cleanly and
reports a 0.4200 mm wall. The checker is not wrong; it measures walls, and the
walls really are 0.42. It simply does not measure this.

Reversing every triangle's winding flips each normal, so the SAME unmodified
algorithm rays outward and measures the air instead. Done that way the channel
comes back as exactly `pitch - rib` at every pitch, which is both the answer and
the proof the technique is sound. `tools/nso_skin_fine_test.js` asserts the
blind spot as a gate so nobody re-derives it.

**The answer, in the repo's own figures.** One extrusion line is
`nso_thickness.floorFor(nozzle)` = nozzle x 1.05, the figure that already turns
a 0.4 nozzle into the 0.42 mm rib. Tightest pitch with a full line of air is
`rib + line`: **0.84 mm at a 0.4 nozzle, 1.05 mm at a 0.6 nozzle**.

- The asked-for **0.5-0.6 mm pitch is past a real limit**, not merely tight: it
  leaves 0.08-0.18 mm of air, 5.3x to 2.3x narrower than one 0.4-nozzle line. A
  slicer gap-fills that and the lattice comes out a solid plate. Not forced.
- `crosshatch-fine` is **0.84 mm**, the 0.4-nozzle floor - 1.43x the ribs per
  axis, not the ~2.4x a 0.5 pitch implies.
- **0.84 is 0.4-nozzle only.** At a 0.6 nozzle one line is 0.63, so a 0.42 mm
  channel fuses; worse, the 0.42 mm rib is itself under one 0.6-nozzle line.
  **The shipped 1.2 mm default is essentially the 0.6-nozzle floor already**,
  which is why it stays the default and the tighter pitch is opt-in.
- On the Bambu measurement that started this: 0.61 mm rib at "0.5 mm spacing"
  cannot be a 0.5 mm PITCH - the rib would be wider than the pitch and the
  lines would overlap into a sheet. So 0.5 is the GAP, Bambu's pitch is 1.11 mm
  against NSO's 1.2, and the real difference is the channel (0.5 vs 0.78).
  Matching Bambu's channel at a 0.42 rib is a 0.92 mm pitch; the preset's 0.84
  goes past it. The density gap closes on the gap reading; the literal
  pitch-to-pitch target does not exist.

**A preset, not a second builder.** `PATTERNS` entries carry `family`, every
dispatch downstream switches on the family rather than the name, and the
preset's output is asserted BIT-IDENTICAL to `crosshatch` at
`params: { pitch: 0.84 }`. All seven committed skin and patch fixtures
regenerate byte-identically; the skin, wrap and patch suites are untouched.

**`sandwich`, and why `bordered` is the wrong piece for a sandwich test.**
`bordered` is a closed tray - a solid 0.6 mm floor with the relief on ONE side.
Between two cubes only the top one meets rib tips; the bottom meets a flat
30 x 30 mm plate and welds on contact area alone whatever the pattern does.
`bordered` is unchanged and stays exactly what it is; `sandwich` is the
two-sided piece, and it is two-sided BY CONSTRUCTION:

- **No floor.** Every cell is empty top-to-bottom or solid top-to-bottom, so
  the whole piece is one height field with a common base and `looseGrid` builds
  it unmodified. Asserted as volume = contact x height exactly - a membrane has
  nowhere to hide in a closed form.
- **Prismatic**, so the `z = 0` face and the `z = h` face are THE SAME SET. Both
  contacts measured off the mesh and asserted equal: 696.082 mm2 each.
- **A frame rib, not a rim.** A proud rim would hold the two cubes off the
  pattern entirely and measure itself; a flush rim would add ~138 mm2 of solid
  contact per face and swamp the lattice. The frame is one more rib at the
  pattern's own width, and it is WIDENED to meet the outermost rib because
  `ribIntervals` centres its ribs and the leftover (0.09 mm at 0.84 pitch on
  30 mm) would otherwise be an unprintable sliver channel.
- Prismatic is enforced, not assumed: `zigzag` tapers so its two faces differ,
  `ring` has no height field; both refused by name with that reason.

Measured, 30 x 30 x 0.6 mm, one closed component each: the 1.2 sandwich carries
24 ribs/axis and 578.16 mm2 per face, the 0.84 one 35 ribs/axis and
696.08 mm2. Both are in `library/`, so the A/B goes on one plate. Like `loose`,
a sandwich patch is advised **non-solid** and is closed as built, so the flag is
not what gets it through a check.

**The Library rows (Task 2 of the follow-up).** `app-library.js`'s `CATALOG` now
lists ten patches. Registering a name there is NOT the same as the tab loading
it, so `tools/nso_skin_fine_drive_check.js` CLICKS every row in the shipped list
and measures the piece that arrives - footprint, thickness and triangle count
against that file's OWN manifest, never a blanket 30 x 30 (the loose ring is
genuinely 10 x 10 and says so). The six `bordered`/`loose` files are byte-copies
of `fixtures/skin-patches/`, byte-checked on every `--check` run so the tab can
never drift from the gated fixtures.

## The crosshatch welds when stacked - one direction per layer (2026-09-18, same day)
`nso_crosshatch.js` (new), `tools/nso_crosshatch_test.js` (new, 56 checks),
`tools/nso_crosshatch_fixtures.js` (new), `fixtures/crosshatch/` (new),
`docs/CROSSHATCH.md` (new), `tools/nso_raster_line_audit.js` (part 5, now 24
checks), `nso_skin.js` (the PATTERNS note - comment only), `README.md`,
`docs/RASTER-LINES.md`, `fixtures/README.md`. Checks: `npm run crosshatch:test`,
`npm run crosshatch:fixtures`, both in `npm test`.

**THE DEFECT, AND THAT NO ANGLE FIXES IT.** The raster-line audit had already
measured it and refused to fold it in with the zigzag's: the shipped
`crosshatch` runs ribs BOTH ways in ONE layer, so a 90 degree copy's underside is
the same lattice as the tips beneath it and **519.750 mm^2 - 100.0% of the tip
area - welds in a single patch spanning the whole 30 x 30 footprint.** What is
new here is the rest of the sweep, because "turn it further" is the obvious first
idea and it does not work:

| upper copy turned | contact | patches | widest patch |
|---|---|---|---|
| 15 deg | 272.426 mm^2 | 137 | 4.92 mm |
| 30 deg | 252.714 | 138 | 6.42 mm |
| 45 deg | 248.124 | 146 | **30.00 mm** |
| 60 deg | 252.714 | 138 | 6.42 mm |
| 90 deg | **519.750** | **1** | 30.00 mm |

A rotation by 90 maps a square lattice onto itself, and every other angle leaves
two lattices crossing along LINES rather than at points. The best of them still
bonds 248 mm^2 in patches millimetres long. There is no angle; the construction
is the fault. The SECTION is not - the rib is prismatic, 0.42 top and bottom,
`minWall == tipWall`, asserted.

**THE FIX** is the raster tracer's own two-layer reference, generalised: one
direction per layer, two layers, the second crossing the first, built on
`NSO_RasterLines.extrudeFlat` unchanged (the planar subdivision, so a four-way
crossing's pad is exactly the width x width square). Same pitch, same rib, same
height, same footprint, same instrument - the two rows differ in the
CONSTRUCTION alone:

    ribs both ways, ONE layer    519.750 mm^2 in   1 patch,  widest 30.00 mm
    one direction, TWO layers    110.250 mm^2 in 625 patches, widest 0.5940 mm

625 = 25 lines crossed by 25, every patch exactly **0.176400 mm^2 = width x
width**, none spanning more than w*sqrt2 = 0.5940 (the crossing square turned 45
and its box catching the diagonal). The total is predicted from the plan
(`repeats^2 * width^2`) before anything is built and then measured.

**THE GUARD, so it cannot come back quietly.** `directionCensus` histograms a
layer's segment directions BY LENGTH; `oneDirection` refuses a layer whose second
family carries more than 25% of it; `build` runs it on both layers before any
geometry exists. The defect's own centrelines read **50 / 50** and are refused by
name, with the 519.750 in the refusal text. A real layer reads 96.30 / 3.70 (the
3.70 is its end turns). One trap stated outright rather than left to be
rediscovered: measured on the PAIR, the fixed interface also reads 50/50 at 45
and 135, exactly like one bidirectional layer - the histogram only means
something PER LAYER, and both readings are asserted.

**THE END TURN, measured by building the weld it prevents.** A boustrophedon's
turn runs across its own layer's lines, so in the layer above it lies PARALLEL to
that layer's lines (the finding the raster work already paid for). Half a pitch
puts it in the middle of the other layer's channel. `turnOffset` is a parameter
so the rule is measured, not asserted:

| offset | clearance | patches | contact | widest |
|---|---|---|---|---|
| 0.60 (pitch/2) | +0.18 | **625** | 110.2500 | **0.594 mm** |
| 0.42 (one line) | 0.00 | 597 | 110.2500 | 2.291 mm |
| 0.30 | -0.12 | 577 | 114.7429 | 2.291 mm |

At exactly one line width the AREA does not move at all - abutting strips
intersect in nothing - but the patches MERGE, 597 instead of 625 with welds 3.9
crossing squares long. That is the case a total hides and the patch clustering
catches. So `plan` REFUSES a pitch whose half does not clear the line, by name
and with the number: width 0.61 at pitch 1.2 (clearance -0.01) and
`crosshatch-fine`'s 0.84 at width 0.42 (clearance 0.00) are both refused, and the
refusal names both ways out. `ends: 'open'` is one of them - separate lines, no
turns, several components REPORTED rather than hidden (the call
`nso_skin_patch.js` already makes for `ties: 0`), and the contact is identical
either way, which is the proof the turns touch nothing.

**RE-TILING, NOT SCALING (the second half of the ticket).** `c_k = width/2 +
turnOffset + k*pitch` does not depend on `repeats`, so re-tiling APPENDS lines
and never moves one: all 16 centres of a 19.62 mm pattern are bit-identical in
the 44.82 mm one, with pitch, width, height and channel bit-identical too. The
price is a quantised span - `fitRepeats` reports the residual rather than
absorbing it (30 mm asked -> 25 repeats, 30.42 mm, +0.42 residual; modes
nearest / down / up). The control is the design pattern this replaces: the same
20 mm build SCALED by 2.2844 to reach the same span gives line 0.42 -> **0.9594**,
channel 0.78 -> **1.7818**, height 0.60 -> **1.3706**, crossing 0.176400 ->
**0.920543 mm^2**. Every figure the pattern is made of, at once.

**AND WHETHER THE RASTER PATH WOULD HAVE BEEN SIMPLER - measured, since the
ticket asked.** This module's own paths stroked into a canvas sized for the
pattern, thresholded, thinned, traced back and built at the same fixed width:
20 mm target -> 31 segments / 612 tris traced against 31 / 612 laid out directly,
line length 324.80 vs 325.20 (0.12%); 30 mm -> 49 / 972 either way, 778.76 vs
778.80 (0.005%). So the raster path WOULD re-tile correctly - it is the longer
way round to a path three numbers give exactly, and it adds Zhang-Suen's chamfers
and junction clusters to a layout that has neither. The parametric layout ships;
the round trip stays in the test as the check that the two agree.

**CANONICAL CHECKER.** One layer: 0 open, 0 non-manifold, 0 degenerate, 0 sliver,
0 winding, **0 piercing, 0 coplanar**, Euler 2, `--gate` PASS. The stack: two
closed shells, Euler 4, 0 open, and at gap 0 exactly **4 coplanar + 8 piercing
pairs PER CROSSING** - the same per-crossing signature the raster reference gives
(225 crossings -> 900 / 1800), so it scales with the crossings and is the contact,
not penetration; gated as that exact multiple. Controls: 0.05 apart -> 0 / 0;
0.05 INTO -> 8300 piercing. `--gate --non-solid` at 0.42 fails and names the
0.3 mm LAYER HEIGHT, and passes at `--min-wall 0.3`, both directions asserted -
the same reading as a traced flat line.

**SCOPE.** Geometry only, NOT wired into the UI - the raster importer's scope
line. The shipped `crosshatch` relief is UNCHANGED and stays what it is: correct
against a flat mating face, where `tipContactArea` is the right instrument and
the tip area IS the contact. Its PATTERNS entry now says in the file what it is
not, and points here.

## The reference raster was drawn at the wrong ANGLE (2026-09-18, same day)
`tools/nso_raster_fixtures.js` (ANGLE / TURN / CANVAS and `turned`),
`tools/nso_line_angle.js` (new: the instrument), `nso_raster_lines.js`
(`weldNodes`, and the pad now OWNS its attach corners), `fixtures/raster-lines/`
(all four regenerated), `docs/RASTER-LINES.md`. Check: `npm run raster:angle`,
plus four gates inside `npm run raster:test` (now 134 checks).

**The bug, and why nothing caught it.** A slicer prints an interface layer at 45
degrees to the part's axes and the next at 135, which is where the 90 between
them comes from. The reference raster committed with the feature was drawn
AXIS-ALIGNED - vertical lines joined by horizontal turns - and **every other
number in the suite still held**, because every one of them is angle-blind: the
section, the closure, the contact per crossing, the patch count are all
invariant under a rigid turn, and two layers 90 degrees apart cross at 90
degrees whatever absolute angle they sit at. Nothing measured the orientation,
so nothing saw it. Measured now, with the instrument that was missing:

| | dominant band | 45 +/-1 | 90 +/-1 | 0 +/-1 |
|---|---|---|---|---|
| as committed | **89 +/-1 at 94.03%** | **0.00%** | 94.03% | 3.85% |
| now | **45 +/-1 at 93.99%** | **93.99%** | **0.00%** | **0.00%** |

The remaining 6.01% is the end turns, perpendicular to the lines by
construction and therefore at 135; the two families are 100.00% of the wall
length. The crosshatch, having two line families, reads 48.87% at 45 and 49.52%
at 135, and 0.00% at both axes.

**The instrument** (`tools/nso_line_angle.js`) histograms the SHIPPED MESH's
vertical-wall edge directions into 1-degree bins, weighted by horizontal length,
undirected. A line of length L and width w contributes 2L at its own angle and
2w of cap at 90 degrees to it, so a long thin line's own angle dominates its own
weight - which is what makes the share meaningful rather than a triangle count.
It also histograms the tracer's own paths, and the check requires the two to
agree, because the mesh is what ships and the path is only what the tracer
believes. One reporting subtlety worth knowing: a +/-1 band is a window, so
neighbouring centres TIE whenever the weight sits in one bin (44 +/-1 and 45
+/-1 both cover bin 45), and the tie is broken on the centre bin's own weight -
without that a family genuinely at 45 reports as 44.

**The fix is a RIGID TURN of the whole pattern, not a redraw.** The path shapes
are still laid out in the pattern's own 30 x 30 frame exactly as before and
`turned` maps that frame into the canvas at ANGLE. Rigid is the point: layer 2
is still layer 1 turned 90 degrees, so the two-layer assembly is the OLD
assembly turned 45 degrees as a whole, and every contact figure is therefore
expected to be IDENTICAL rather than merely similar. The check asserts that
equality instead of assuming it - **39.6900 mm^2 before, 39.6901 after, 225
patches of exactly 0.176400 mm^2 either way**, and 83.7226 -> 83.7225 at the
0.61 mm line. The inset finding reproduces too (inset 1.00 -> 197 patches with
2.02 mm welds, 57.064 mm^2; inset 0.25 clean at both widths).

`ANGLE` names **the angle the lines run at**, not the rotation applied. The
first attempt rotated by +45 from vertical and put the lines at 135 and the
turns at 45 - the right diagonal, the wrong one of the two - so the constant
names the measured quantity and `TURN = ANGLE - 90` is derived. `CANVAS` is
derived from both, because a 30 mm pattern turned 45 degrees needs 30 * sqrt(2)
= 42.43 mm of room: 45 mm at 20 px/mm, so the rasters are 900 px square.

**Four independent gates, so it cannot drift back:** the wall histogram on the
mesh; the same histogram on the tracer's paths, which must agree; the solid's
bounding box being SQUARE, since a W x H rectangle turned 45 degrees has a bbox
of (W+H)/sqrt(2) in BOTH axes and that holds at 45 and at no other angle
(40.947 x 41.191 measured, 41.253 predicted); and a crossing patch's bbox
spanning w * sqrt(2) = 0.5940 rather than w, because the w x w square is itself
turned (0.5943 measured).

**Two tracer faults the angle change uncovered, neither reachable with
axis-aligned input.**

1. *Junction clusters at diagonal crossings.* A right-angled X thins to one
   clean degree-4 pixel; a 45 degree X does NOT - Zhang-Suen leaves a cluster of
   Y-junctions joined by one-pixel bridges. Measured on the 45 degree
   crosshatch: **960 graph nodes where a clean lattice has 225 junctions and 60
   line ends, 900 traced paths shorter than 0.1 mm, closest node pair exactly
   one pixel apart**, and `extrudeFlat` refused the lot - correctly, a 0.05 mm
   segment cannot carry a 0.42 mm line's joins. `collapseShort` could not help:
   it fixes a short segment INSIDE a polyline, where one end is a free vertex it
   may move, and here BOTH ends are junctions. New `weldNodes` clusters
   endpoints within one line width, moves each to its cluster's centroid and
   drops what collapses, iterated with a guard. The four arms then meet at one
   point: 480 segments, **225 junctions**, one component, Euler -390 = genus 196
   preserved.
2. *Slivers at welded junctions.* A welded junction's arms are a fraction of a
   degree off perpendicular, so the pad's wedge point no longer lands exactly ON
   its attach point the way it does at a true right angle - it lands microns
   away and leaves a sliver: **776 triangles over aspect 100, the worst a 0.0037
   mm edge against a 0.30 mm one.** Two changes, and the second is the
   structural one. A wedge point within 2% of a line width of the corner beside
   it is dropped, which is safe because it is the pad's OWN vertex and nothing
   else references it - that halved the count. The rest were between two SHARED
   corners, which cannot be dropped, so the pad now **owns its attach corners**:
   they are computed once onto the `inc` entry and the quads read them from
   there instead of recomputing the same formula, which lets edge i's left
   corner and edge i+1's right corner be MERGED to their midpoint with the quads
   following for free. One corner, two quads, watertight by the same argument as
   before because there is still exactly one point. **0 slivers on all four
   fixtures, worst aspect on the crosshatch 115 -> 16**, closure, Euler and
   piercing unchanged.

**One number that legitimately stopped holding, and is not papered over.** The
three zigzag rasters no longer come out as the same 572 triangles. That equality
was an artefact of axis-alignment: Zhang-Suen chamfers a DIAGONAL corner more
heavily the fatter the stroke, so a fat diagonal boustrophedon keeps a few extra
corner vertices (29 / 54 / 34 segments). The claim the fixture set exists to
make - that the picture's stroke width never reaches the SECTION - is now gated
on what actually carries it: the same 0.42 mm width, the same line length to
0.8%, and the same footprint to a third of a millimetre. The anti-aliased
fringe's size moved for the same reason (1.91x the core then, 1.33x now, a 3 px
stroke at 10 px/mm having less core against its ramp), so that gate asks for a
substantial grey band rather than a pinned ratio.

## A raster of line art as flat printed lines (2026-09-18)
`nso_raster_lines.js` (new: the whole pipeline, browser + Node),
`tools/nso_raster_lines_cli.js` (new: raster -> STL on the command line),
`tools/nso_contact_area.js` (new: the measuring instrument),
`tools/nso_pnm.js` (new: netpbm read/write, dev tools only),
`tools/nso_raster_fixtures.js` (new: the rasters and their STLs),
`fixtures/raster-lines/` (four rasters + four STLs + `raster-lines.json`),
`docs/RASTER-LINES.md`. Checks: `npm run raster:audit`
(`tools/nso_raster_line_audit.js`, 21 checks - Task 1), `npm run raster:test`
(`tools/nso_raster_lines_test.js`, 134 checks - Tasks 2 and 3),
`npm run raster:fixtures` (byte-diff). All three are in `npm test`.

Asked for as the answer to a measured problem: the Skin patterns are RELIEF
profiles - a rib or a sawtooth ridge STANDING on a plane - and a two-layer
breakaway interface needs a real printed line's section, flat and thin.

**Task 1, the audit, and the diagnosis holds - on the zigzag.** Two copies of
the shipped loose zigzag patch, the upper turned 90 degrees across the lower and
set down on its tips, which is Bambu's two-layer construction. Measured with
`interfaceContact`, which intersects the two meshes' material regions IN the
interface plane as real 2D polygons (A's up-facing faces against B's
down-facing ones) and clusters the result into PATCHES, so a total cannot hide
whether it is isolated dots or one broad weld:

- every ridge crossing bonds over **0.42 x 1.20 mm = 0.5040 mm^2**, 195 of them,
  because a standing sawtooth is 0.42 mm at its CREST and 1.20 mm where it meets
  the plate and the upper copy presents its WIDE end to the interface. A real
  0.42 mm printed line, whose section is the same width top and bottom, bonds
  over 0.1764 mm^2. **2.857x, and the ratio IS base/tip = 1.2/0.42.**
- the whole 30 x 30 interface: **115.020 mm^2 in 197 patches**, of which two are
  the TIES, welded continuously over the full 30 mm (8.3700 mm^2 each). Against
  39.690 mm^2 in 225 isolated dots for the flat line. 2.898x.
- interface thickness **2.04 mm** against 0.60 mm for two real layers. 3.40x.
- the crossing is still **1.354x** even the WIDEST measured real line, 0.61 mm.

**The control that settles it, because "the profile is the problem" is otherwise
just a story.** Keep the path, the pitch, the 15 ridges and the 90 degree
crossing FIXED, ties off, and turn the upper copy over so a 0.42 mm crest meets
a 0.42 mm crest instead of a 1.20 mm base: **0.1764 mm^2 per crossing, to the
digit**, and 39.690 mm^2 total - the flat line's figures exactly, with the same
225 crossings. And contact scales linearly with the base width alone, tip fixed:
base 1.2 / 0.9 / 0.6 -> 0.5040 / 0.3780 / 0.2520 mm^2 per crossing, each equal
to 0.42 x base to the digit. The section is the whole variable. (Turning a patch
over is a MEASUREMENT isolating one variable, not a printable proposal, and the
audit says so where it does it.)

**And the crosshatch is a DIFFERENT fault, which the audit refuses to fold in
with it.** Its ribs are PRISMATIC - 0.42 mm top and bottom, `minWall` ==
`tipWall`, asserted - so the section is not its problem. Its problem is that ONE
layer already runs ribs BOTH ways, so a 90 degree copy's underside is the same
lattice as the tips beneath it and the two coincide instead of crossing:
**519.750 mm^2 = 100.0% of its tip area, in a SINGLE patch spanning the whole
30 x 30 footprint.** A real layer runs lines in one direction and gets its
crossing from the next layer. So the crosshatch needs a one-direction path and
the zigzag needs a flat section - which is why the importer takes the PATH from
a raster and the SECTION from two numbers.

One measurement that is NOT reusable and is worth saying so: `zigzag` with
`base` equal to `tip` is not a valid control. `zigzagPlan`'s gaps exist because
the profile falls to 0 at each ridge's edge, so at flank 0 the cells BETWEEN
ridges read `h` at both nodes and fill: 853.927 mm^2 of contact, nearly the
whole footprint. The taper is load-bearing in the plan, not only in the section.

**The measured line, and one of the two numbers is not new.** `LINE_HEIGHT` 0.3,
`LINE_WIDTH` 0.42, `LINE_WIDTH_MAX` 0.61 - tonight's Bambu values. 0.42 is also
`nso_skin.js`'s crosshatch rib, `nso_skin_patch.js`'s `MIN_WALL` and
`mesh_validate.py --min-wall`'s threshold: one extrusion line at a 0.4 nozzle.
The measured value and the repo's own figure are the same number, which is why it
is the default. Both are parameters at every entry point, and NOTHING infers a
width from the image - the raster gives the CENTRELINE, the caller gives the
section. That is the whole reason to trace rather than extrude the black pixels,
and the fixtures prove it: the same centrelines drawn with a 0.25 mm stroke and
with a 0.65 mm stroke (2.3x the ink) trace to the same 29 segments and build the
same 572 triangles.

**Task 2, and why `extrudeFlat` is a planar subdivision rather than one prism per
line.** Written literally, "extrude each traced line as a flat thin solid" is one
closed prism per polyline, and at every crossing two of them occupy the same
cubic millimetre: each prism closed, an open-edge count clean, the union
self-intersecting - the exact failure the patch work already paid for twice
(2590 and 2488 piercing pairs, both invisible to a closure check). Uniform
height is the scope, so the solid is a PRISM OVER A 2D REGION and the union is
done once, in the plane, exactly: each graph NODE gets a convex PAD (junction,
corner, or nothing for a butt cap), each EDGE a QUAD between the two pads' attach
edges, pads and quads sharing the IDENTICAL two points where they meet; top
faces at `z = height`, bottom at 0, and a wall on exactly those edges used by ONE
face. Every edge is then used by exactly two triangles - watertight by
construction with no self-intersection, the same reason `looseGrid` is. **A
4-way crossing's pad is exactly the width x width square**, which is the number
the feature exists for. Mitred to 4 half-widths (SVG's own
`stroke-miterlimit` default), bevelled beyond, so a hairpin cannot throw a spike.

Two things it can be asked to do and cannot, both measured as real intersection
AREA between the faces (so abutting reads zero and correctly passes) and both
refused by name: `tightSegments`, a segment shorter than the joins at its ends;
`overlapPairs`, two lines within a line width of each other with no node between
them - a folded hairpin, or a line ending part-way along another. From a skeleton
neither can happen; `extrudeFlat` is a public entry point, so both are checked.

**Two stages exist because of something measured, and each has its own gate.**

1. *The reduced 8-neighbourhood in `tracePaths`.* A diagonal neighbour is ignored
   when a shared 4-neighbour already connects it. Without the rule, on a
   14-pixel diagonal staircase a naive 8-neighbour count calls **12 of the 14 a
   junction** and one drawn line comes back as a pile of stubs. The test asserts
   both the one-path result AND the naive count, so the rule is visibly doing
   work rather than being asserted to.
2. *Collapsing a chamfer to its CORNER in `collapseShort`.* Zhang-Suen chamfers
   a right angle, so a traced boustrophedon corner arrives as a 0.158 mm stub at
   45 degrees which survives Douglas-Peucker because it really is that far off
   the chord - and a stub shorter than the line width cannot be drawn as a flat
   line of that width at all. The first version DROPPED one end of the stub,
   which folds the chamfer into the long line beside it and TILTS it: 0.25 mm of
   drift over a 29 mm line, half a degree, which turns a crossing from 0.176400
   into 0.176410 mm^2. Collapsing to where the two straight runs MEET leaves both
   exactly straight. Endpoints are never moved - they are the junctions other
   paths meet at.

Also pinned rather than left to be rediscovered: a W x H bar thins to a row
**W - H** long - the ends retract by half the stroke width. It is why the fat
raster traces 468.15 mm of line where the thin one traces 469.53.

**Task 3, the reference interface, and the number asked for.** The committed
`zigzag-layer.pbm` is the real two-layer zigzag's one layer at the SHIPPED
patch's own numbers - 30 x 30 mm, 15 lines, 2.0 mm pitch, centres exactly where
`ribIntervals(30, 1.2, 2.0, 0)` puts its ridges - so this measurement and the
audit's are the same measurement of the same interface, differing in the section
alone. Traced: 1 continuous boustrophedon path, 29 segments (15 lines + 14 end
turns), 0 junctions, 572 triangles, Euler 2, one component, 0 open, 0
non-manifold, 0 degenerate, 0 sliver, **0 piercing, 0 coplanar**, exactly
0.3000000 mm tall, volume == top-face area x height.

Then the same layer turned 90 degrees and set down on it: **39.6900 mm^2 of
contact in 225 patches, every one exactly 0.176400 mm^2, none spanning more than
one line width.** 225 = 15 x 15; the total is the crossings and nothing else; the
interface is 0.600 mm thick. At the widest measured line, 0.61 mm: **225 patches
of exactly 0.372100 mm^2**, 83.7226 mm^2 - still less than the relief patch's
115.020 at the NARROW line. Controls, the ones the repo's other contact checks
use: 0.05 mm apart -> two closed shells, Euler 4, 0 piercing, 0 coplanar; gap 0
-> coplanar contact on exactly 900 triangle pairs = 225 crossings x 4, which an
air gap never produces, and layer 1's top z == layer 2's bottom z bit for bit;
0.05 mm INTO -> piercing, as penetration must.

The `crosshatch` raster is the crossing case: 15 lines each way in ONE picture
trace to **225 four-way junctions**, max degree 4, one component, 5760 triangles,
**Euler -390 = genus 196 = the 14 x 14 holes in the lattice**, 0 piercing.

**A finding about the PATH, not the section, that the importer is what found.** A
boustrophedon's END TURN is a rail, and in the layer above - the same layer
turned 90 degrees - it lies PARALLEL to that layer's lines. Put it within one
line width of them and the interface bonds along the rail's whole length instead
of at a point. On the reference raster, whose traced centres sit at 1.025,
3.025, ... mm:

| end inset | 0.42 mm line | 0.61 mm line |
|---|---|---|
| 1.00 mm | rail lands ON the 1.025 line: 197 patches, 2.42 mm welds, 55.899 mm^2 | worse |
| 0.50 mm | clean (225 patches), but only because 0.5 > 0.42 | 197 patches, 2.61 mm welds, 87.984 mm^2 |
| 0.25 mm | **225 isolated crossings** | **225 isolated crossings** |

0.25 leaves 0.775 mm of clearance, more than the widest measured line, so that is
what the committed raster uses. The rule: **the end turn must clear one line
width of the layer above's outermost line.** A pattern-geometry constraint, not
an importer defect - all three rows are in part 8 of the test so it cannot be
forgotten.

**`--min-wall`, and the checker being right about the wrong question.** A traced
layer is 0.3 mm thick, so `--gate --non-solid`, which switches the wall/gap check
on at 0.42 mm, FAILS it and names the layer height as the thinnest wall. 0.42 is
the NOZZLE figure - a limit on how thin a wall can be in PLAN - and 0.3 is the
LAYER HEIGHT, printable by definition because it is exactly one layer. So a flat
line's gate is `--gate` for closure plus `--gate --non-solid --min-wall 0.3`, and
part 5 asserts BOTH directions: the 0.42 gate fails and names 0.3000 mm as the
cause, the 0.3 gate passes with 0 thin faces. All four fixtures also pass the
repo-wide `python3 tools/fixture_audit.py --gate`.

**Task 4, scope, held.** Flat line tracing only: binary or thresholded input,
uniform extrusion height. A grey picture is thresholded to ink or not-ink and
every line comes out the same height. No grayscale height-map relief mode -
that is a separate idea and nothing here starts it.

**Not wired into the UI, and that is the one thing a reader should not assume.**
This is a module plus a command-line importer; the STL it writes drops into Nest
through the ordinary file input like any other piece. There is no button, and
therefore no drive check through real Chromium - unlike Skin patch, which has
both. The next ticket is a **Trace raster** button in the Finish tab beside Skin
patch, ADDING a piece rather than replacing one, and nothing here is in its way:
`buildFromImage` already takes exactly the shape `canvas.getImageData` returns
(`{ width, height, data, channels }`, RGBA and its alpha floor handled), and
`nso_raster_lines.js` already attaches itself to `window` as a classic script -
part 9 loads it in a `vm` sandbox, builds through `window.NSO_RasterLines` there,
and feeds `buildFromImage` an RGBA `ImageData` unconverted. The module deliberately decodes no image format,
because in the browser the canvas already decodes every format the browser can
open; `tools/nso_pnm.js` exists only so the Node checks can read a real file off
disk, and is not shipped.

## A skin pattern as its own printable object - the patch (2026-09-17)
`nso_skin.js` (two additive exports, `planeFrame` and `patternPlan`, plus the
audit written out next to them), `nso_skin_patch.js` (new: both variants),
`app-skin-patch.js` (new: the **Skin patch** button, which ADDS a piece rather
than replacing one), `index.html` (a third `.vp-row-skin` row in the Finish
tab), `fixtures/skin-patches/` (six STLs + `skin-patches.json`). Checks:
`npm run skin:patch` (`tools/nso_skin_patch_test.js`, 111 gates),
`npm run skin:patch-drive` (`tools/nso_skin_patch_drive_check.js`, 73 checks
through the shipped controls and the real export path),
`npm run skin:patch-fixtures` (byte-diff of the committed fixtures). All three
are in `npm test`.

Asked for as the standalone counterpart to Skin / Skin wrap: bake the relief
pattern alone, floating, like a washer you can test in isolation.

**Audit first (Task 1), and the answer is two-sided.** The question was
whether `nso_skin.js` builds the relief as an independent geometric structure
before fusing it onto a host face, or whether generation is inseparable from
fusion. It is independent, and measured rather than read:

- `crosshatchPlan` and `zigzagPlan` are pure functions of a frame and their
  parameters. They return a HEIGHT FIELD - `breaksU`, `breaksV`,
  `cellHeights` - not geometry. `gridRelief` and `ringRelief` turn that into
  triangles reading only the frame and its `sides`, and never the soup being
  skinned. The soup enters at exactly four places, all of them about the
  HOST: `findFace` (which face), `rectFrame` (the frame, from that face's
  boundary loop), `registerWallVertices` and `fanWalls` (the seam).
- The proof: skin the same 30 x 30 +Z face on a 30x30x8 block and on a
  30x30x2 plate, and the relief triangles come back BIT-IDENTICAL - 9402
  crosshatch, 434 zigzag, 864 ring, every one equal - while the host wall
  fans differ. Part 1 of the new test asserts it.

**But the independent structure is not a printable object, and that is what
decided the design.** Taken on its own the relief is a zero-thickness OPEN
SHEET: Euler 1, 196 / 116 / 96 open edges, bbox height exactly the skin height
with nothing below it. `gridRelief` emits the top surface and the walls
*between* cells and stops; the back, and the watertightness, come from the
host. So "export the pattern alone" cannot be keeping the relief triangles and
dropping the rest - what comes out has no thickness and no back.

The path that works was already in the file: `freeLayerShell` gives its free
second layer **a host of its own** (a `boxSoup` slab) and calls
`applySkinToFace` on it. Both variants generalise that, and the two additive
exports are what a caller outside the module needs to do it - a frame built
from numbers instead of from a boundary loop, and the height field behind it.
Nothing in `nso_skin.js` changed behaviour: `tools/nso_skin_samples.js`
regenerates all nine committed skin samples byte-identically, and the skin and
wrap suites are untouched.

**What Skin patch does.** `NSO_SkinPatch.buildPatch(opts)` returns a soup and
its numbers; `NSO_skinPatchAdd` hands that to `addModelFromZUpGeometry`, the
same ingest path an imported STL takes, so the patch arrives with `rawTris` in
file axes and every later tool - Seat, Repair, *Check piece*, both exporters -
sees an ordinary piece. It is **not** a bake on the selection: it adds a piece
and leaves every existing one alone (the drive check loads a cube, bakes all
six patches, and the cube's triangle count, size and flag are untouched). Its
paint scope is therefore NONE rather than sub-region - it reads no existing
geometry at all.

- **bordered**, the washer. A closed TRAY - a 1.2 mm rim standing on a 0.6 mm
  floor membrane - whose POCKET FLOOR carries the relief, skinned by
  `applySkinToFace` itself through `findFace`'s plane offset: the shipped
  inner-face path, the one a selected pocket floor already uses. So the seam
  work, the perimeter subdivision and the wall re-fanning are the validated
  code and none of it is copied. The rim stands 0.6 mm PROUD of the tips, so
  the rim takes the handling and the relief does not. One closed shell,
  Euler 2, 30 x 30 x 1.8 mm (2.2 for the ring).
- **loose**, the raw patch. The pattern's features as SOLID BODIES and nothing
  else: no rim, no backing plate. Built from `patternPlan`'s height field as
  the solid `{ 0 <= z <= h(u,v), h(u,v) > 0 }`, meshed as a cell complex over
  the plan's own grid. The gaps between features really are empty - the test
  measures volume against the bounding box rather than asserting it
  (crosshatch 57.7%, ring 17.3%). The ring, which has no height field, is
  built as what it is: a closed tapered annulus, 10 mm across.

**Thickness (Task 3): every figure reused, none invented.** `MIN_WALL` 0.42 mm
is `nso_skin.js`'s own crosshatch rib and the threshold `mesh_validate.py
--min-wall` carries; the 0.6 mm floor and the 0.6 mm proud are
`freeLayerShell`'s `sheet` default; the 1.2 mm rim is the crosshatch `pitch`.
The footprint is 30 x 30, `A_SIZE` in `tools/nso_skin_samples.js`, so a patch
and the skin sample it came from are the same pattern over the same area. The
one-line guard is on each pattern's BASE section, never its tip: the zigzag and
the ring taper on purpose - minimal contact is the point of them - and the
ring's shipped `wallTip` is 0.4. `buildPatch` reports `minWall` and `tipWall`
separately so the taper is visible instead of averaged away.

**Three defects found by measurement, each fixed and each now gated.** All
three were invisible to a closure check alone, which is why they are worth
recording.

1. *The tray's T-junctions.* Written out the obvious way - one bottom quad,
   four outer walls, a rim frame, four pocket walls - the rim frame's inner
   edge ran the full width while the pocket walls met only part of it. The
   bare 28-triangle tray came back with **16 open edges, 10 piercing pairs and
   Euler -2**, and every bordered patch inherited them (2590 piercing pairs on
   the crosshatch). Fixed by building the tray as a height field over the
   3 x 3 grid `[0,i0,i1,W] x [0,j0,j1,D]` and handing it to the same solid
   builder the loose variant uses, where every cell edge is shared by exactly
   two cells. 68 triangles, Euler 2, clean.
2. *The relief landing in the pocket wall's plane.* At `margin: 0` the pattern
   runs to the pocket's edge and its end walls land IN THE PLANE of the pocket
   wall - the collision `freeLayerShell` already guards its sheet against.
   **2488 piercing pairs on the bordered crosshatch, 868 on the zigzag, with
   0 open edges and Euler 2 throughout**, so only the self-intersection check
   saw it. The bordered variant's margin is now `MIN_WALL` and `margin: 0` is
   refused by name.
3. *A third height on a node.* The loose zigzag's flank is a 33-degree wedge
   whose perpendicular distance to its own underside is **0.367 mm on all 30
   flanks** - under one extrusion line, and a real feather edge at the build
   plate, not a measuring quirk. Fixed with a 0.42 mm vertical FOOT under each
   feature's own footprint (`LOOSE_BACK`, per pattern: the crosshatch's ribs
   are prismatic and read 0.42 as they are, the ring's taper is 11 degrees off
   vertical and reads 0.566, only the zigzag needs one). The foot then put a
   third height on the corner where a tie cell, a flank cell and an empty cell
   meet, and one quad per grid edge cannot subdivide for it: **180 open edges**,
   with ties alone and a foot alone each clean. Fixed by splitting each wall at
   ITS OWN end node's height set and zippering the strip between the two
   chains, the way `ringRelief` already zips its floor to the rectangle.
   (Splitting both ends at the union of the two nodes' levels is wrong in the
   same way as not splitting at all, and was measured being wrong.)
   `gridRelief` upstream emits one quad per edge and is correct only because
   the shipped patterns never put a third height on a node; the new builder
   cannot borrow that assumption, and carries a `crossings` counter so a
   future pattern that needs a mid-span vertex cannot do it silently.

**Ties.** A pattern whose features do not touch each other is several loose
sticks and not a patch you can pick up: the zigzag's ridges are parallel and
share nothing, and `ties: 0` really does come back as **15 separate closed
shells, Euler 30**. So `loose` adds two cross-ribs one extrusion line wide,
merged into the same height field rather than resting on it, and the patch is
one component (Euler -26, genus 14 = 15 ridges x 2 ties). The crosshatch needs
none - its ribs cross - and the ring is one body already.

**The non-solid flag (Task 4), and the honest answer is not the expected one.**
`loose` defaults to FLAGGED and `bordered` does not, but not for the reason the
ticket assumed, and the difference matters enough to state plainly: **every one
of the six patches is a CLOSED shell.** 0 open edges, 0 non-manifold, 0
degenerate, 0 piercing, all six. They pass `--gate` and `--gate --non-solid`
alike, and part 4 of the test runs both on all six. So the flag is *not* what
stands between these files and a pass, and section 3's "declare `--non-solid`
if intentional" is not doing any work here.

- **loose is flagged anyway, as a declaration.** It is a free-standing
  one-extrusion-line lattice, which is the printable-fabric case
  `docs/NON-SOLID.md` names, and the stages the flag stands down - Repair's
  hole fill, flap peel and orphan-component drop - are exactly the ones that
  would quietly trim it if it ever stopped being closed. That is the same kind
  of declaration Skin's free layer already makes: nothing is measured off the
  mesh, the user chose a construction, and the bake says so in its status.
- **bordered is not flagged, and the rim question is answered by measurement
  rather than assumed.** The rim does not "enclose" the pattern topologically -
  the relief is open to the air above, as any washer's mesh is - but it does
  not need to: the piece is one closed shell either way, and the rim's job is
  mechanical. Flagging it would only remove a check it passes.
- The wall/gap check the flag turns on is the interesting one and all six pass
  it: crosshatch 0.420 mm (the ribs, at threshold, as on the skin sample),
  zigzag 0.420 with the foot and 0.600 bordered, ring 0.566 both ways.

**Numbers the fixtures carry** (`fixtures/skin-patches/skin-patches.json`,
byte-diffed by `npm run skin:patch-fixtures`):

| patch | extent mm | tris | comp | walls mm | contact mm² | flag |
|---|---|---|---|---|---|---|
| crosshatch bordered | 30 x 30 x 1.80 | 8892 | 1 | 0.42 | 409.15 | - |
| crosshatch loose | 30 x 30 x 0.60 | 13100 | 1 | 0.42 | 519.75 | non-solid |
| zigzag bordered | 30 x 30 x 1.80 | 612 | 1 | 0.60 -> 0.42 | 146.11 | - |
| zigzag loose | 30 x 30 x 1.02 | 1164 | 1 | 0.42 | 208.91 | non-solid |
| ring bordered | 30 x 30 x 2.20 | 1022 | 1 | 0.60 -> 0.40 | 11.56 | - |
| ring loose | 10 x 10 x 1.00 | 768 | 1 | 0.80 -> 0.40 | 11.56 | non-solid |

**The drive check (Task 5)** presses the shipped button six times and checks
the file the browser downloaded. Per patch: a new piece appears with `rawTris`
in file axes, the status names the variant and its walls, the non-solid state
is read off the shipped checkbox (not off the model object), then Format = STL
and **Download selected STL** - and the download goes through
`mesh_validate.py` twice, `--gate` and `--gate --non-solid`, both PASS, plus a
thickness assertion. The download is compared to the committed fixture as
GEOMETRY, not bytes: the exporter writes the piece's display geometry, which
`addModel` centres and which has been through Z up -> Y up -> Z up, so the
bytes legitimately differ. Triangle count, bounding box, volume and the
translation-invariant triangle set all match. Byte identity between the
module's output and the fixture is held separately, in part 5 of the unit
test. No page errors. `APP_URL=<site>` points the same check at a deployment.

**Not done, on purpose.** The patch is a flat rectangle like everything else
below `rectFrame`; a curved one was the "OTHER wrap" ticket above, since
landed as Texture, and nothing here changes it. The patch is not offered as a Seat target - it is a
coupon you print and handle, and Seat's footprint measurement is about an
interface between two pieces. And `bordered` does not offer a round rim: the
tray is a rectangle because `rectFrame` needs one, which is the same
constraint the rest of the module has.

## Multi-piece lock, the plate lock, and packing around a lock (2026-09-16)
`app-poslock.js` (the plate lock and the HUD line it owns), `app-core.js`
(`state.plateLock`, the `plateLockReplace` undo, and `runOptimize` /
`packModels`), `app-mask.js` (one line, so the HUD stops clobbering the lock),
`index.html` / `styles.css` (the second button). Check: `npm run lock:multi`
(`tools/nso_multilock_test.js`, in `npm test`, 83 checks through the shipped
controls in headless Chromium). The original `npm run lock:test` (74 checks) is
unchanged and still green.

**Audit first (Task 1), and the report it came from was wrong on both counts.**
The ticket said "only one piece can be locked at a time" and "no way to
select/drag other pieces while one is locked". Driven in the real app:

- *The flag was never one-at-a-time.* `m.posLock` is one boolean per model
  object; nothing anywhere holds "the locked piece", there is no plate-level
  or module-level lock variable, and `syncOutlines` / `syncListTags` already
  loop over every piece. The shipped `nso_poslock_test.js` had A **and** B
  locked at once, and then all three, before this ticket existed. Lock A,
  lock B, lock C in turn: each lands on its own model, and at every step the
  pieces not yet locked are selected by a real click and moved by a real
  80 px drag (40.0 mm, 35.5 mm, 34.6 mm). Section 1 of the new check pins
  this.
- *Nothing freezes the viewport.* The first read said otherwise, and the
  probe was wrong, not the app: it started its orbit drag at the canvas
  corner, which misses the plate, and `onCanvasPointerDown` only re-enables
  rotate when the ray hits plate. Aimed at a point the app's own ray test
  confirms is plate-and-not-piece, the camera moves with no lock (229),
  with one (260), with three (200), and immediately after a REFUSED drag on
  a locked piece (120). `state.controls.enabled` is never left false by a
  refusal - `startMoveDrag` returns before it touches the controls.

What the audit DID find, and what this commit is:

1. **The HUD line lost the lock on every selection** - a real bug, and the
   likeliest thing behind "no way to verify lock state". `app-sel-outline.js`
   wraps `selectPlaced` and calls `nsoMaskHudRefresh()` AFTER it, which at
   rest writes the bare `HUD inside4` tag into `#adjust-status` - straight
   over the `Locked #n` that `updateAdjustUI` -> `syncButton` had just put
   there. So the lock's own HUD line survived only until you clicked a piece,
   including clicking the locked piece itself. Fixed at the one writer:
   `nsoMaskHudRefresh`'s at-rest branch now asks `nsoPosLockHudLine()` first
   and falls back to the tag. The lock line also now carries the count, and
   says `N pieces locked elsewhere` when the selected piece is free but
   others are held - so several locks read back without selecting each one.
2. **`Optimize plate` was dead**, and had been since `3ff99f1`. `runOptimize`
   read `#opt-orient.checked`, `#opt-rotate.checked`, `#gap.value` and
   `#stats.classList`; not one of those ids is in `index.html` (the Pack card
   ships the button alone), so the first line threw and the button answered
   `Optimize failed. Check console.` every time. Pre-existing and nothing to
   do with the lock, but it is the nesting path the ticket says is blocked,
   so it could not be left. Every optional control is now read defensively
   with a conservative default: keep the uploaded orientation, do NOT yaw
   pieces the user placed (`allowRotate` false), 2 mm gap.
3. **A repack ignored the locks.** `runOptimize` rebuilt `state.placed` from
   scratch, so once it worked it would have relocated every locked piece.

**The plate lock (Task 3), deliberately a second concept.** `state.plateLock`,
one boolean, toggled by `#btn-plate-lock` ("Lock plate" / "Unlock plate") next
to the per-piece toggle. It holds the whole arrangement in one action and is
NOT "lock every piece": it writes no `m.posLock`, so
`state.models.map(m => m.posLock)` is byte-for-byte identical before it, under
it and after it - pinned in section 3. Three accessors, each with one meaning:

    nsoPosLocked(m) / nsoPosLockedPlaced(p)   this piece's own flag
    nsoPlateLocked()                          the arrangement is held
    nsoPosHeld(p)                             either - "cannot be moved"

`nsoPosLockBlocks(p, verb)` now reads the union and names which lock refused
the move (`Plate locked - drag refused on <name> - the whole arrangement is
held; press Unlock plate to move anything` vs the original piece wording, which
is unchanged to the character). The nine gated call sites in `app-core.js` were
not touched. Indicator: the plate border turns teal (`0x38bdf8` -> `0x2dd4bf`,
re-applied on every refresh because `buildPlateMesh` repaints it), the model
list gets `is-plate-locked`, all 15 move/pose buttons are greyed whatever is
selected, the per-piece toggle is disabled but still LABELS that piece's own
flag, and adjust-status reads `Plate locked - N pieces held...`. Undo entry
`plateLockReplace`, its own step.

**Packing around a lock (Task 2's real content).** `packModels` takes a fifth
argument, `blockers`: world XZ footprints the packer may not place on,
inflated by `gap` so a packed piece lands the same clearance from a locked
neighbour as from a packed one. `subtractFreeRect` cuts each one out of the
free-rectangle list up front (up to four surviving strips per rect).
`runOptimize` builds them from the locked pieces, asks `buildInstances` for
that many fewer copies of each model, keeps the locked pieces' `p` entries AND
their exact `mesh` objects (so a Skin/Soften/Repair bake on a locked piece, and
its lock outline, survive a repack of everything around it), clears only the
meshes being replaced, and restamps `placedIndex` on everything because the
held pieces come first in `state.placed`. Status: `Packed 1 model around 2
locked pieces, which did not move - ready to export`. With the PLATE locked,
the repack is refused outright before anything is touched - it is the one
non-move operation the plate lock blocks, because it is the one that rebuilds
the arrangement.

**Validation (Task 4)**, `tools/nso_multilock_test.js`, three `box-20mm`
pieces, every gesture a real mouse gesture:
- lock A, B, C one at a time; after each, every still-free piece is clicked,
  selected, its 15 toolbar buttons confirmed live, and dragged 80 px; orbit
  measured after each lock and after a refusal (all four move the camera).
- three locked at once: three tags, three outlines, `nsoPosLockCount() === 3`,
  three refused drags with no undo entry; unlock the middle one and it drags
  again between two locked neighbours while the other two stay locked.
- plate lock with exactly ONE piece lock underneath: all three pieces refuse a
  drag by the plate's name, the flag array is unchanged by locking AND by
  unlocking, after unlock the two unflagged pieces drag and the flagged one
  still refuses by its OWN name. Undo of the plate lock leaves the piece locks
  alone.
- all nine gated paths (nudge, Raise, Lower, yaw, edge, tip, roll, bank,
  pitch) refused on an UNFLAGGED piece under the plate lock, no undo entry,
  `Plate locked` named each time.
- Optimize with A and C locked: both keep their exact x/z and their exact mesh
  uuid, B is repacked to a new mesh, both outlines survive, no two footprints
  overlap, indices restamped, and B still drags afterwards. Optimize under the
  plate lock: refused by name, `[x, z, mesh.uuid]` identical for all three.
- export: the STL is byte-identical with nothing locked, with three piece
  locks, and with the plate locked on top - neither lock is in the file.

**Known limits, stated not solved.**
- `m.posLock` is per MODEL, so several placed instances of one model (what
  `quantity > 1` produces through Optimize) share one lock and cannot be
  locked apart. Clone makes a new model, so the clone path is unaffected, and
  the ticket asked for the flag to stay where it was built. A per-instance
  lock would have to move the flag onto `p`, which is the object a repack
  replaces.
- A piece loaded onto an already-locked plate is held too - the plate lock is
  one flag over `state.placed`, not a remembered set. The three indicators
  (greyed buttons, teal border, HUD line) say so; unlock to place it.
- The plate lock refuses movement, not deletion: Remove still deletes a piece
  from a locked plate, which leaves the rest of the arrangement intact.
- `Optimize plate`'s four missing controls are still missing from
  `index.html`. They are now optional rather than fatal; adding the card back
  would make auto-orient, yaw and the gap reachable again.

## Seat refuses a bit the target face cuts through (2026-09-17)
`app-join.js` `NSO_seatStraddle` / `NSO_SEAT_STRADDLE_TOL` and one gate inside
`NSO_seatFlushBitToHull`. Check: `npm run seat:overhang`
(`tools/nso_seat_overhang_test.js`, in `npm test`, 44 gates). Found beside the
local-carve audit, not reported from the bed: a bit sitting ACROSS a hull wall
seats "successfully", and the seat eats every millimetre that stood proud.

**The defect, measured.** Hull `box_hull_80x40x20-2` (80 x 40, 20 tall),
bit `hinge_knuckle_box` (18 x 8 x 8), the bit put across the hull's +X wall at
mid-height: 6 mm of it proud of `x = 40`, the other 12 mm already inside the
hull. Seat flush returns `Seated - proud 0.01mm, skin error 0.00mm - Subtract`
and leaves the bit at `x 22.01 .. 40.01` - the 6 mm driven to 0.01 mm and the
whole bit buried as a plug through that face, with no warning anywhere. Seat
(support) at -0.18 takes the same pose and teleports the bit 12 mm the other
way, out of the hull, and also says `Seated`.

Why it was reachable and why it survived every earlier suite: the fit refuses
as soon as a corner ray misses (`corner N missed hull along punch axis`), and
over the hull's TOP face a straddling bit always has a corner in the air, or
else its footprint is inside the hull's and `NSO_raiseBuriedBitClear` lifts it
clear first. A vertical WALL is different - it can shadow all four corner rays
at once, and nothing raises a bit sideways. The same bit 7 mm higher (2 of 4
rays miss) and at the vertical edge (1 of 4) refuse exactly as they always
did, so the shipped behaviour flipped between "refuse" and "swallow the bit"
across a 7 mm move. Neither the Seat-gap nor the Seat-align fixture pair can
reach the pose at all: a 20 mm cube against a 20 mm wall always has two
corners off the wall, which is why both suites pass on the defect.

**Fix.** `NSO_seatStraddle` (pure; the seat calls it once, on the pose it was
given, before the tips probe and the fit). It casts the fit's own four corner
rays and compares each hit with the bit's depth along the punch axis: `d >=
depth` everywhere means the bit is clear of the face and approaches it (the
staged plug, the raised bit, the side seat); `d <= 0` everywhere means it is
wholly inside (a plug being re-seated). In between, the face cuts through the
bit, and the seat refuses with the millimetres at stake:
`Seat failed - bit straddles that hull face - 6.00mm of it stands proud and
the rest is already inside. Move it clear of the face (or fully inside) and
seat again`. Nothing is moved - both buttons already restore the bit on a
refused seat, and the plate export is byte-identical across the click.
`NSO_SEAT_STRADDLE_TOL` is 0.1 mm, so the 0.01 mm a flush seat leaves standing
proud and the 0.05 mm the gap slider's overlap end pushes in are the seat's own
handiwork, not an overhang: seating twice in a row still lands `===`.

**Validation** (`tools/nso_seat_overhang_test.js`, real buttons and the
canonical checker). The reported case refused by both buttons, the bit's
position / quaternion / x / z / liftY and the exported plate STL identical
across the click, and the same placement with the guard stubbed out still
producing the shipped 6 mm -> 0.01 mm burial, so the gate cannot pass
vacuously. A 504-placement sweep - four walls x seven heights x nine depths,
both modes - with 185 seats, 176 straddle refusals and 143 missed-corner
refusals: no placement seats while the face cuts through the bit, every
refusal restores the pose exactly, and the probe moves nothing. Untouched:
the Seat-gap golden flush pose and status to 1e-9, a flush seat repeated,
the side plug (a bit clear of the wall driven in to 0.01 proud), the buried
plug pulled back out, the locked -0.18 easy-release seat with its export
through `tools/mesh_validate.py --json` (watertight, 0 piercing, 0 coplanar,
two shells 0.18 mm apart), +0.05 and 0 re-seated from their own results, and a
-0.18 gap seat against a wall. `npm run seat:gap` and `npm run seat:align`
unchanged, and `npm test` green. (When this landed, the four steps that launch
Playwright's own default browser build - `cth-test/capture-check.mjs`,
`cth-test/drive-check.mjs` and the two `3mf-test` drive checks - could only run
here with a hand-installed Playwright that matched the sandbox's Chromium. The
devDependency is pinned to that version now, so a clean `npm install` runs all
of them; see the 3MF checks section.)

**Known limits, stated not solved.**
- A bit that straddles is refused, not rescued. The vertical case has
  `NSO_raiseBuriedBitClear` to lift a buried bit clear and seat it from above;
  there is no sideways equivalent, and inventing one would move a piece in XZ,
  which is the user's own placement. The message says which way to move it.
- Clicking Seat flush a second time on a SIDE plug refuses with `corner 0
  missed hull along punch axis`, with this guard and without it:
  `NSO_raiseBuriedBitClear` counts the seated plug as buried (its footprint is
  inside the hull's to the 0.05 mm pad its 0.01-proud face now sits within),
  lifts it above the hull's TOP, and the corner just past the top face's edge
  misses. Older than this work, untouched by it, and pinned at the core where
  the re-seat does hold.
- The straddle gate reads the bit's box corners, like the fit it guards. A bit
  whose silhouette is much smaller than its box can have all four corner rays
  clear of the hull while the body is not; that is the fit's own assumption,
  not something this gate narrows.

## Seating side by side - the corner rays are inset (2026-09-17)
`app-join.js` `NSO_SEAT_RAY_INSET` / `NSO_seatRayOrigins` (every corner ray in
the seat now leaves from those origins), and `NSO_SEAT_BED_EPS` in
`seatBitAtGap`'s lift clamp. Check: `npm run seat:side`
(`tools/nso_seat_side_test.js`, in `npm test`, 72 gates). This closes the
limit the vertical-stacking work stated and did not solve: "Two pieces resting
side by side on the bed never seat horizontally - `Seat failed - corner 0
missed hull along punch axis`."

**Audit first (Task 1), and the reading it confirmed.** The limit's own
diagnosis held up against the code, and the numbers are these. Hull
`box_hull_80x40x20-2` settled on the bed (`0.2 .. 20.2`), `box-20mm` dragged
beside it 3 mm off the `+X` wall: the plug frame picks `+X`, and the four rays
leave the bit's `+X` face corners along `-X`. The two at `y = 20.2` hit the
wall at `x = 40`, `d = 23`. The two at the bit's bottom do not. Both bottoms
are on the bed baseline by construction - `settlePlacedOnBed` puts every
world-box bottom on `0.2 + liftY` - so those rays travel *along* the hull's
bottom edge, where `NSO_rayTri` needs a strictly interior barycentric hit and
the graze measures ~1e-9 of the wrong sign. The fit refuses on the first one.

Swept through the real app: 60 side-by-side placements (four walls x five
distances from the wall, `0 / 0.18 / 1 / 3 / 10` mm, x three slides along it).
**All 60 lose at least one corner ray with the origin at the corner**, at an
inset of 1e-9 too. At 1e-7 and above, 50 of them recover all four; the other
10 are the slides that hang 3 mm past the hull's own `+Z` edge, and they keep
missing at every inset out to 0.01 mm - a bit that overhangs the target face
must still refuse, and it does. No recovered ray reports the far side of the
hull: every one measures the near wall, `d = 20 + the staged distance`, exact
to 1e-6.

*The sweep is a gate now, not an audit number (2026-09-18).* It first landed as
a measurement quoted here and nowhere else, which left the inset's value
resting on a number no check could reproduce. It is section 10 of
`tools/nso_seat_side_test.js` - 20 of that suite's gates - staged through the
app's own `settlePlacedOnBed` / `nudgeSelected` path so the bed baseline is the
one the seat sees, and run as corner-ray arithmetic over the 60 poses rather
than 60 clicks, so it costs one page round trip instead of a minute. It pins
every number in the paragraph above: 60 placements, the 10 that overhang
derived from the geometry rather than hardcoded, all 60 losing a ray at inset 0
and at 1e-9, 50 recovering and those same 10 still refusing at each of 1e-7 /
1e-5 / 0.001 / 0.01, every recovered ray measuring the near wall, and 0
straddle flags throughout. Load-bearing, checked the way section 2 checks the
fix: with the inset taken back out of `NSO_seatRayOrigins`, four of the gates
fail.

**False-positive straddle - the thing to get wrong.** The overhang gate
(`NSO_seatStraddle`, "Seat refuses a bit the target face cuts through") reads
the same four rays and skips itself entirely when one misses (`if (!h) return
null`). So the rays could not be fixed in the fit alone: the fit would seat a
bed-level straddle the gate had just been blinded to. Both read the inset
origins now, and per the gate's own arithmetic a side-by-side pose can never
read as a straddle - a corner cut needs `off + 0.1 < d < depth - 0.1`, and a
bit that stands clear of the wall has `d = depth + its distance from it`.
Measured, not just argued: 0 straddle flags across all 60 placements at every
inset from 0 to 0.01 mm, and the overhang suite's own 504-placement sweep
returns the same counts as before this change - 185 seated, 176 straddle
refusals, 143 missed-corner refusals. What did change is the bed-level
straddle the gate used to lose: 6 mm of the bit proud of the `+X` wall on the
bed now refuses by name instead of by missed corner.

**Fix.**
- `NSO_seatRayOrigins(corners)` pulls each ray origin `NSO_SEAT_RAY_INSET`
  (0.001 mm) along the face's own diagonal toward the face centre - a fraction
  of the way, never a fixed step, so a sub-millimetre bit still samples inside
  its own face. The offset is in the face plane, which is perpendicular to the
  punch axis, so every measured `d` is unchanged: pinned at 1e-12. One micron
  is ~100x the Float32 vertex noise a plate-sized coordinate carries and 1/100
  of `NSO_SEAT_STRADDLE_TOL`, 1/10 of the gap slider's step - no offset the
  seat can express sees a different point. Used by all five corner-ray sites:
  the fit loop, `NSO_seatStraddle`, `NSO_seatTipsProbe`, the residual report,
  and the `Flush` readout.
- `NSO_SEAT_BED_EPS` (1e-6) in `seatBitAtGap`. A horizontal seat never changes
  the bit's height, so a settled bit comes back with `liftY = -1e-16` and the
  old `if (lift < 0)` appended "bit would sink below the plate, held at plate
  level: gap NOT as requested" to a seat that had done exactly what was asked.
  The clamp to 0 stays; only the warning now needs a real sink.

**Validation** (`tools/nso_seat_side_test.js`, real buttons and the canonical
checker). The staging is asserted to be the grazing one (both world-box
bottoms `===`). With `NSO_seatRayOrigins` stubbed back to the bare corners the
same click reproduces `Seat failed - corner 0 missed hull along punch axis`
and moves nothing, so the gates cannot pass vacuously. Seat (support) at
-0.18: `Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`,
mating face 0.18 off the wall, the bit still on the bed (bottom `===` the
hull's, `liftY` 0), Z, mesh y and the quaternion untouched, one undo entry,
re-seat and Undo both `===`. The export through `tools/mesh_validate.py
--json`: 40 triangles, 0 open, 0 non-manifold, volume 71360.000 (hull + bit),
0 piercing, 0 coplanar, width 100.18, height 20, two shells 0.1800003 apart
along X, both on z = 0. -0.05 and 0 through the slider with their own export
signatures (0 gives coplanar contact, as it does stacking). All four walls
seat, each moving the bit along that axis only. Seat flush side by side gives
the side plug, outer face 0.01 proud. A 6 mm bed-level straddle is refused by
both buttons with the pose and the plate export identical across the click.
The clamp: a stubbed 1e-9 drop seats clean, a stubbed 1 mm drop still warns.
`npm run seat:gap`, `npm run seat:align` and `npm run seat:overhang` are
unchanged, golden poses and counts included.

**Known limits, stated not solved.**
- A bit that overhangs the target face still refuses on the overhanging
  corner. The inset is a micron; it rescues a graze, never a real overhang,
  and the sweep pins that at 10 placements out to a 0.01 mm inset.
- The seat still samples the hull at four points. A hull feature between them
  is invisible to the fit, inset or not - that is the corner-ray fit's own
  assumption, unchanged here.
- Gap 0 side by side exports coplanar contact, exactly as gap 0 does when
  stacking: two shells touching, which the canonical checker counts.

## Size — scale a piece to a real dimension (landed, `app-scale.js`)

Added 2026-09-17. The audit that preceded it is the short version of why the
file exists: **there was no scale control of any kind** on `claude-wip` — not a
dimension box, not a factor box. Every occurrence of "scale" in the wired app
was camera zoom (`onViewportWheel`), a `mesh.scale.copy` in the mask overlay, or
a three.js `addScaledVector`/`multiplyScalar`. A piece's size came from its file,
and only Cut, Thicken, Solidify and the Finish bakes moved it. So "make this
exactly 50 mm tall" had no answer at all, and neither did "half size".

The Size card in the left panel now has both, and the first is the point:

- **Set size** — pick X, Height, Z or *Longest edge*, type the mm, press. The
  factor is solved for you and applied to all three axes.
- **Scale by** — the plain uniform multiplier, which is the primitive the first
  one is built on.

**Uniform only, deliberately.** "50 mm tall" on a part means the part at 50 mm,
not a part squashed on one axis. Non-uniform scale moves wall thicknesses, hole
roundness and overhang angles independently, and nothing downstream expects it —
not Cut's raw mapping, not the packer's footprint, not Soften's radius. A
per-axis stretch would be a different feature with a different name.

**Paint wins, whole-piece.** A uniform scale moves every vertex and there is no
sub-region to scope the check to, so by the scoping rule above any painted face
stands the whole operation down, naming the count — the same answer Smooth
gives. Worth recording why this is not just inherited: a mask entry is a plane
`{n, d}`, and under a uniform scale about the bbox centre `n` is unchanged while
`d` scales, so the paint *could* be carried through arithmetically. Doing so
would be a second mapping from a plane back to a face, which is exactly the
re-derivation the standing rule forbids. Until the mask stores something
scale-invariant, refusing is the honest answer.

**Exactly, and what "exactly" can mean.** The soup is a `Float32Array` and stays
one, so the span the file carries is a difference of two 24-bit mantissas. On
every fixture measured the result lands on the nearest float32 to the requested
millimetre — for 12.7 mm that is 12.699999809265137, off by 1.91e-7 mm, which is
`|float32(12.7) - 12.7|` and irreducible by any factor. `NSO_scaleSolve` keeps a
correction loop (`f *= target / measured`, always re-derived from the original
soup so error cannot compound, best result kept). It is measured, not assumed:
over 200,000 random (offset, extent, target) triples, **8,660 improved, 0
worsened, 191,340 unchanged**, best gain 2.3e-4 mm. The unchanged majority is
the easy case — a piece near the origin. The 4% that improve are meshes whose
coordinates sit far from the origin, i.e. any STL exported without recentring,
where both ends of the span round on a much coarser grid than the span itself.
`tools/nso_wire_scale_test.js` section 8b reproduces one (2.36e-4 → 8.52e-6 mm,
27.6× closer, two passes).

**Do not gate this with `NSO_edgeStats`.** That welder quantises on a FIXED 1e-4
mm grid, which is correct for a bake that leaves the piece the same size and
wrong for one that does not: scale a sound mesh up by 10 and two vertices that
shared a grid cell no longer do, so it reads as newly open; scale a torn one
down and they merge, so it reads as freshly healed. Neither is a fact about the
mesh. `NSO_scaleTopoStats(soup, q, areaEps)` takes the quantisation from the
caller, and `NSO_scaleGate` hands the after-mesh `q / factor` and
`areaEps * factor²`, so the two measurements are of the same shape at the same
relative tolerance and any difference is real. It compares triangles, distinct
vertices, distinct edges, open edges, non-manifold edges and degenerate
triangles; the gate runs before anything is committed.

**Guard rails.** Factor must land in 1e-4..1e4, and the result must be at least
0.1 mm on its shortest axis — the same floor `addModel` uses to call a loaded
mesh empty, so a scale can never produce a piece the loader would reject. Every
refusal leaves the piece byte-for-byte unchanged.

### `npm run wire:scale` — in `npm test`, so CI gates it

`tools/nso_wire_scale_test.js` drives the real app in headless Chromium, then
measures the **file**, not the app's opinion of itself: it reads the piece's soup
back out of the page, writes a binary STL with `tools/nso_stl_io.js`, and runs
the canonical checker — `python3 tools/stl_watertight_check.py <f> --odd --degen`
— on the before and after copies. Eleven sections; 80x40x20 box and
`fixture_sphere_curved.stl`, both axis targets and longest-edge targets, the
factor button, undo (bit-for-bit restore), eight refusals, and the painted
stand-down.

**Negative-controlled (section 4b), because a green checker run means nothing if
red is unreachable.** One vertex of the scaled result is nudged 1 mm and the
same checker command turns red — `open_edges 0 → 4, odd_edges 0 → 4, FAIL odd
edges` — while the untouched result stays OK. The app's own gate gets the same
treatment: `NSO_scaleGate` is handed that torn soup and refuses it
(`distinct vertices changed 16->17`), so the gate is live rather than
decorative.
