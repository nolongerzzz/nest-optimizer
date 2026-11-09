# Measure — click-to-measure on the plate

`app-measure.js`, the **Measure** button in the Finish menu, and
`tools/nso_measure_test.js`.

Click two points on the pieces and read the distance between them in
millimetres (or inches - see section 5), or switch to **Edge** and click one
edge for its length. The number is drawn on the piece, not only written to the
status line. Section 5 adds a 300 mm / 12 in **ruler** you drag over the
viewport and line a piece up against.

---

## 1. The audit: what already picks and what already draws

This tool was written after reading the mechanisms the app already had, and it
reuses them rather than growing a parallel set. What follows is what each one
does and what Measure took from it. The first four sections were written
against `claude-wip` at `2a6d07a`; the last four were added at the merge, when
Check piece, Skin and Carve had landed.

### mask6 paint — `app-mask.js`

The oldest and the most careful of the three. What it settled, and Measure
inherits:

| it does | Measure does |
|---|---|
| `setPointerFromEvent` + `state.raycaster` + `state.pointer` from app-core, then `intersectObjects(state.modelGroup.children, true)` | the same, in `hitPiece()` |
| `hitFace()` skips its own overlay in the hit list | `hitPiece()` skips this file's helpers |
| `overlay.raycast = function () {}` — a helper that answers the ray eats the next click | every helper this file adds gets the same stub, in `addHelper()` |
| `window.nsoMaskTakesClick(event)`, asked by app-core's `onCanvasPointerDown` before it starts a move drag | `window.nsoMeasureTakesClick(event)`, asked in the same place, three lines below it |
| reads the index buffer when the geometry has one — `t*3+v` straight off the position buffer walks onto an unrelated triangle | `topologyOf()` reads through `geo.index` for the same reason |
| welds vertices at 1e-4 (`Math.round(p*1e4)`) to flood-fill a coplanar face | same quantisation, `WELD_Q`, to weld the topology |
| disposes geometry and material on clear | `dropHelpers()` |
| an explicit `renderOrder`, with a comment on where it sits in the ladder | `MEASURE_RENDER_ORDER = 30`, see below |

The one thing Measure deliberately does **not** borrow is the HUD line.
`#adjust-status` is the paint's running count (`hudPaint`), and two tools
writing one line is how a count turns into a lie. Measure writes `#status` and
its own chip. `tools/nso_measure_test.js` B3 asserts `#adjust-status` comes out
of a measuring session byte-for-byte as it went in.

### the Soften / Join face pick — `app-finish.js`

`nsoFaceFromHit()` is the app's one answer to "which face is this?", and
`storeFacePick()` / `showPlanarHighlight()` / `showFaceHighlight()` are how a
pick is drawn. Measure does not call `nsoFaceFromHit`, because it does not need
a *face*: it needs a point, and specifically a point that can be pinned to a
corner or an edge. But it takes the drawing conventions whole —
`depthTest: false`, `depthWrite: false`, `transparent`, an explicit
`renderOrder`, added to `state.scene` in world space, removed and disposed by
one clear function.

Not its colour, though, and this took three goes. `showPlanarHighlight` is cyan
and says why it is not amber: amber next to the paint's yellow is two signals
that look like one. That rules yellow out here too — but cyan was wrong as
well, and a screenshot of the first cut showed it plainly: `PIECE_COLOR` is
`0x38bdf8`, so a cyan line drawn **on** a piece is a cyan line on cyan. A
translucent face wash gets away with that; a one-pixel line does not. Rose
`0xfb7185` replaced it, and survived until this merge — when `SELECT_COLOR`
turned out to have become rose `0xf43f5e`, putting the same mistake on the
piece you are most likely to be measuring.

Measure is **lime `0xa3e635`** throughout — button, line, end dots and the
chip's border. It is what is left once the plate's ten claimed colours are
struck out (the list is in `app-measure.js` above `MEASURE_COLOUR`), and it
reads hard against both piece colours and against the dark plate.
`tools/nso_measure_test.js` A6 now reads those constants out of their own files
and fails if any of them ever equals this one, so the next accent cannot repeat
the mistake quietly.

### the selected-piece outline — `app-sel-outline.js`

`THREE.EdgesGeometry(geometry, 15)` — the 15-degree threshold that decides
which edges of a piece are drawn white when it is selected. Measure's
feature-edge test is the same 15 degrees (`EDGE_ANGLE_DEG`), so **an edge this
tool will measure is an edge the app already draws**. What you can see is what
you can click. It also inherits that file's hard-won note on `depthWrite`: a
line with `depthTest` off passes every depth check, so writing depth would leave
a hidden edge's z in front of the face it crosses and reject whatever is drawn
after it.

### the CTH harness — `cth/`, `app-cth.js`

Gated behind `?cth=…` and removable; it mounts its own overlay card and its own
`raycastables` list. Nothing here is on the shipped path, so Measure takes no
code from it — but `cth/overlay.js`'s `buildAimSummary` is the model for how
this file is split: the geometry is pure and free of THREE and the DOM, so a
Node test can check it without a browser.

### Check piece, the defect overlay — `app-defects.js`, `nso-defects.js`

Written against `claude-wip` at `2a6d07a`, this section read "what was NOT
found": the brief named a defect overlay and a Skin face-select, and neither
existed yet. Both landed before the merge, so here is what they actually are
and where each stands next to Measure.

The defect overlay draws the canonical checker's findings on the mesh — open
edges red, non-manifold edges orange, piercing triangles red, thin walls
violet. It reached the same conclusions this file did, independently and from
the same sources: line layers off `app-poslock.js`, patch layers off
`app-mask.js`, `raycast` stubbed on every layer, an explicit place in the
renderOrder ladder, and marks that end when the piece is re-baked under them.
Nothing had to be reconciled — the two files agree because they read the same
three predecessors.

They differ in one decision, and the difference is right both times:

| | Check piece | Measure |
|---|---|---|
| what a mark means | *where the piece is broken* | *how big this is* |
| `depthTest` on patches | **off** — a piercing pair is usually inside the piece where nothing can see it | off on the line too, but the pick that made it had to be visible |
| renderOrder | 50 / 52, above the paint | 30, below the paint |
| ends when | the button, or a bake swaps `p.mesh` | the button, Esc, or a bake swaps the geometry the anchor was taken on |

The renderOrder split is the interesting one. Both are transient, on-demand
answers, but the check outranks the paint (a fault you cannot see is worse than
a skip list you cannot see) and Measure does not (a ruler laid over a painted
or a faulty face should lose to both). Put another way: 30 is below everything
that is an *answer about the piece*, and above everything that is a *helper*.

### Skin — `app-skin.js`, `nso_skin.js`

There is no separate Skin face-select to reconcile with. Skin's target is the
paint's own SELECT list: `app-mask.js` grew `Paint Selected` beside
`Paint Excluded` (target pink `0xf472b6` at renderOrder 41), and Skin reads it.
One picking system, two lists — so Measure inherits from the same file it
always did, and `state.maskPaint` simply became `false | 'exclude' | 'select'`.
Measure's `disarmOthers()` reads that three-state value and clicks whichever
paint button is actually live.

### Carve — `app-carve.js`, `nso_carve.js`

The one real overlap, and it is worth being precise about, because at a glance
the two look like the same feature.

`app-carve.js` answers `window.nsoCarveTakesClick` — the identical contract to
the paint's, arrived at independently, with a `hitPiece()` that is line for
line the same idea as this file's. That is convergence, not duplication:
app-core asks all three predicates in a row and each tool's own hit test lives
with the tool.

`nso_carve.js` classifies a click as **face, edge or corner** — which sounds
like Measure's snap, and is not:

| | `nso_carve.js` | `app-measure.js` |
|---|---|---|
| input | the planes within the blade's reach of the click | the piece's welded mesh topology |
| grouping | clusters planes at `DIHEDRAL_DEG = 20`, transitively, so a tessellated dome is *one* face | marks feature edges at 15°, the threshold `EdgesGeometry` draws with |
| output | a frame — an aim direction and a roll for the blade | a point, or a length in mm |
| why that threshold | 20° keeps a 12° dome facet from reading as an edge to cut along | 15° so a measurable edge is exactly an edge the selection outline already draws |

Two thresholds, two questions, and neither should be changed to match the
other. Nothing is shared between them and nothing should be: a blade aimed by a
measurement's idea of an edge would chamfer the facets of a dome.

### the four picking modes, and who wins a click

As of this merge, `app-core.js`'s `onCanvasPointerDown` asks, in order: paint,
carve, measure, then the Soften pick, the Cap pick and the Join pick inline.
Measure is asked **last of the three predicates** because it is the only one
that cannot change the piece — if two modes are somehow armed at once, the one
that bakes should win the click rather than have a measurement swallow it. In
practice it never comes up: `disarmOthers()` turns the other four off when
Measure arms, through their own buttons so none is left lit and inert, and
`tools/nso_measure_test.js` B9 drives all three button pairs to prove it.

---

## 2. What the tool does

**Toggle.** `Measure` in the Finish menu, beside `Paint faces`. It is a mode,
so the button carries its own state the way Paint's does: `Measure` at rest,
`Measuring… click to stop` while live, rose while armed. Arming Measure disarms
Paint, the Soften pick and the Cap pick — one picking mode at a time, because
two armed tools fight over the same `pointerdown`. Esc clears the measurement
without leaving the mode.

**Two points** (`Two points` in the mode select). Click, click. The line, two
dots and a chip with the number appear; the status line adds the per-axis
deltas and what each end snapped to.

**One edge** (`Edge`). Click once, near an edge. You get the length of the
whole edge, end to end.

**Snapping** is what makes the number match the drawing. A click within 14
screen pixels of a corner *is* that corner; failing that, a click within 14
pixels of a visible edge is the nearest point on that edge; failing that, the
click stands where it landed. 14 pixels is a screen quantity, so it is spent
through `mmPerPixel()` — the same conversion that holds the marker dots at a
constant size however far you zoom out. Two corners of a 20 mm box read
20.000 mm, not 19.7-ish, and the readout says `vertex → vertex` so you know
that is why.

**Units.** One world unit is one millimetre: `buildPlateMesh()` builds the plate
as `PlaneGeometry(plate.w, plate.d)` from the plate's mm figures, and a piece is
added with its geometry unscaled. The distance is measured in world space and
printed as mm with no conversion.

**Render order.** The ladder on a piece: selected outline 12, inspect cage 16,
armed-face highlight 20, Paint Excluded 40, Paint Selected 41, Check piece's
patches 50 and lines 52, the position lock 999. Measure sits at **30** — above
the three helpers, below everything that is an answer about the piece. A
measurement drawn across a painted or a faulty face loses to both, and that is
the ladder working.

**Anchoring.** An endpoint is stored as (piece, the point in *that piece's* own
space, the geometry it was picked on) — never a world point. The measurement is
recomputed from world space every frame, so nudging, rotating or re-seating a
piece moves its measurement with it and updates the number instead of leaving a
stale one on screen. A re-bake hands back a different geometry object, and a
local point on the old one means nothing on the new one, so the measurement
drops itself and says so.

**Edge chains.** A mesher is free to cut a 40 mm edge into four 10 mm pieces; a
person clicking it means the 40. So from the clicked edge the walk follows
collinear feature edges both ways and adds them up. It stops at a corner
(nothing collinear carries on) and at a fork (more than one does, so there is no
single honest answer — the readout says `stopped at a fork`). The walk is
strictly outward: a T-junction, where the same span is one long edge on the face
one side of it and two short ones on the other, puts a collinear edge at the far
end running back over the ground just covered. Taking it folded the chain back
on itself and reported a 20 mm edge as 40 — caught by `out-box-square-half.stl`
in A5, which is why "no chain is longer than the piece" is a permanent gate.

## 3. Paint scope

**Measure is not a bake.** It writes nothing to any mesh, `rawTris` or model;
every object it adds to the scene has `raycast()` stubbed out and is disposed on
clear. The standing rule in `docs/HANDOFF.md` — "a painted / excluded face stays
untouched by ANY bake mechanism" — has nothing to bind here: there is no skip
list to read because there is nothing to skip. Measure is therefore deliberately
**absent from the paint-scope roster** in `tools/nso_paint_scope_test.js`. If
this file ever changes geometry, it joins that roster in the same commit.

`tools/nso_measure_test.js` B10 pins it: after a full measuring session the piece
is still 12 triangles of 8000 mm³ and `nsoMaskCount()` is still 0.

## 4. Validation — `npm run measure`

Ground truth is the fixtures' own known sizes, not a previous run of the tool.

**Part A, the geometry alone, no browser.**

| gate | fixture | expected | got |
|---|---|---|---|
| every edge of a cube | `box-20mm.stl` | 12 feature edges, all 20 mm (6 face diagonals are not edges) | 12 × `20.000` |
| body / face diagonal | same | 34.641 / 28.284 | 34.641 / 28.284 |
| snap near a corner | same | the corner, 0.94 mm away, inside a 5 mm tolerance | `vertex` at 10, 10, 10 |
| snap mid-face / out of tolerance | same | no snap | `face` |
| a split edge | synthetic 40×20×10, X cut into 4 | all 16 pieces report the same 40 | 16 × `40.000`, 4 segments |
| against its own bbox | `box_hull_80x40x20-2.stl` | 80 / 40 / 20 present, nothing longer than 80 | 8, 10, 20, 40, 80 |
| against its own bbox | `lid_blank.stl` | 60 / 40 / 2.4 | exactly those three |
| against its own bbox | `out-box-square-half.stl` | 20 / 10, and no fold-back | 20 (1 and 2 segments), 10 |

A6 is the palette gate: it reads `PIECE_COLOR`, `SELECT_COLOR`, the paint's
`SELECT_COLOR`, the three `app-defects.js` colours and `app-poslock.js`'s
outline out of their own files and fails if any equals `MEASURE_COLOUR`.

**Part B, the real app in Chromium** — real button, real clicks at real screen
coordinates, read back through `window.nsoMeasureReadout()`. Clicks are aimed by
projecting a known world point through the app's own camera, and every expected
figure comes from the piece's `THREE.Box3`, measured by three.js and not by
anything in `app-measure.js`.

| gate | expected | got |
|---|---|---|
| top-face diagonal of `box-20mm`, two corner clicks | 28.284 mm, `vertex,vertex`, dY 0 | 28.284, dX −20.000, dZ −20.000 |
| the click did not drag the piece | x, z unchanged, `moveDragging` false | unchanged |
| the chip is on screen, over the piece | visible, inside the canvas, same text | `28.284 mm` |
| `#adjust-status` untouched | identical string | identical |
| move the piece 30 / −12 mm | same distance, both ends moved with it | 28.284, both ends +30 / −12 |
| edge mode, clicked 1 mm inside the top face | 20.000 mm, 1 segment, along X only | 20.000 |
| the 80 mm hull's long top edge | 80.000 mm | 80.000 |
| corner of piece 1 → corner of piece 2 | 10.771 mm (from the two bboxes) | 10.771 |
| piece 2 slides 25 mm | 30.676 mm | 30.676 |
| arming Measure disarms Paint Excluded, Paint Selected and Carve | each stands down, and no button is left lit | clean, all three |
| mode off | readout null, chip hidden, no object left at renderOrder 30 | clean |
| the piece afterwards | 12 tris, 8000 mm³, 0 painted faces | unchanged |

`npm run measure` runs both halves; `npm test` includes it.

---

## 5. Inches, and the ruler

`app-measure.js` (the unit), `app-ruler.js` (the ruler), and gates A8-A10 and
C1-C10 in `tools/nso_measure_test.js`.

### The unit

**Inches** in the Measure card prints every length in inches: the chip on the
piece, the status line (the per-axis deltas too), and the ruler's marks. It is a
*print* choice. The scene is millimetres and stays millimetres: `readout().mm`
and `dx / dy / dz` are mm whatever the box says, `readout().text` is what is
printed, `readout().unit` and `.value` say how. The inch is exactly 25.4 mm.
Inches get four decimals under 100 mm and three above it (the same line `formatMm`
drops a decimal at); `0.0001 in` is `0.00254 mm`, the same order as the
`0.001 mm` the mm form prints. The choice is remembered per browser
(`nso.measure.unit`), and nothing else is.

### The ruler

**Ruler** shows a 300 mm ruler, or a 12 in one (304.8 mm) when Inches is on. It is
drawn on the screen, not in the scene: one transparent canvas over the viewport,
so no scene object is made, there is nothing for `nsoHelpers` to sweep, and it is
not a bake.

- **Drag it anywhere.** Grab the bar (the thin strip the marks hang from) and move
  it over the whole viewport. It never turns - the bar is level on the screen and
  the marks read left to right along the screen's horizontal. It can go partly off
  any edge (so a ruler wider than the view can be slid along), never so far that
  there is nothing left to grab.
- **Only the bar takes the pointer.** The marks and numbers are click-through, so
  you orbit, pan, zoom and click the piece under the ruler. That is the use: set
  the ruler beside an edge, then move the *piece* until the edge sits on a mark.
  `C5` checks it with `elementFromPoint` and with a real orbit drag.
- **The bar's buttons:** `mm`/`in` (the same switch as the Inches box), `⇅` (flip
  the marks to the other side of the bar, so they face the piece) and `×`.
- **Guides** run a faint line down the viewport from every numbered mark.
- Marks thin out and thicken with the zoom: a level is left out when its spacing
  would be under 4.5 px, and numbers go every 10 mm (every 5 when zoomed in; every
  whole inch). Position, flip and Guides are remembered per browser (`nso.ruler.v1`).

### What the scale means

The camera is a perspective one, so the screen has no single mm-per-pixel: a thing
twice as far away is half the size. A ruler laid on the glass is therefore true at
**one distance from the camera**, and this one says which, in the caption on the bar:

| caption | the scale is true at | when |
|---|---|---|
| *true at the pick* | the point you picked (an edge: its middle) | a point or edge is picked |
| *true at the piece under it* | the surface under the middle of the ruler | nothing picked, over a piece |
| *true at the plate* | the plate, under the middle of the ruler | nothing picked, over the plate |

The distance is the depth *along the view direction*, so every point on a plane
square to the view shares one scale. The ruler is sampled with one ray at most
every 100 ms, and **not while the bar is in hand** (sliding it over a 20 mm piece
would otherwise re-scale it by 6 % under the pointer); it settles on release.

This is the honest consequence, and worth stating plainly: in a tilted view the
plate recedes, so the scale under a ruler at the top of the screen is smaller than
under one at the bottom, and a piece's top face is nearer the camera than the plate
it stands on. **For an exact reading, look straight down at the face and pick the
point or edge** - the lamps below tell you when you are.

### Align point and Align edge

Two more entries in the Measure mode select. They find the same things Two points
and Edge do - same snap (corner, then edge, then face), same edge chain, same
anchors (so a pick follows the piece when it moves and drops itself, saying so, when
the piece is re-baked) - and hand them to the ruler instead of drawing a line:

- **Align point** drops a plumb line from the point to the ruler and prints where
  along the ruler it lands.
- **Align edge** does the same for both ends, shades the edge's shadow on the ruler
  and prints `from -> to` and the span, and two lamps:
  - **tilt** - how far the edge is from lying along the ruler, `+` when it climbs to
    the right, lit within 0.5 deg;
  - **depth delta** - how far apart the edge's two ends are in distance from the
    camera, as a share of that distance, lit within 0.5 %. 0 % means the edge is
    square to the view.

  Both lit and the span on the ruler *is* the edge's length. If either is out, orbit
  until it is: `C7` shows the same 20 mm edge reading 20.000 from straight above and
  something else (with both lamps out) from the ordinary 3/4 view.
- **Zero here** slides the ruler along so its 0 sits on the picked point (an edge:
  its left end), leaving its height alone. Then the marks read straight off it.
- Hovering previews what a click would pick (a ring, or an edge with its two ends)
  and **deliberately shows no number**: before a pick the scale is the surface
  under the ruler, and the thing under the pointer may be a different distance from
  the camera (the first cut read 85.2 mm for an 80 mm edge on a 20 mm piece, 6 %
  high, for exactly this reason). The number is for a pick, which sets the scale
  to its own depth. A hover is skipped on a piece with over 60 000 edges (it walks
  them all each time; a click, which runs once, still works).

Esc clears the pick, as it clears a measurement. Leaving Measure clears it too, but
leaves the ruler up: the ruler is not a measure mode.

### Colour and order

Lime, Measure's, throughout: the ruler, its marks, the helpers and the flags in the
card. The canvas sits at `z-index` 20 (bar 22, buttons 23), above the WebGL canvas,
under the measurement chip (30) and the viewport's menus (50).

### Validation

`A8` units (25.4, the two decimals rule, sign, bare deltas). `A9` the marks, against
hand-counted figures: 0-300 numbered every 10 mm with nothing past 300; 61 marks at
3 px/mm; 301 at 6; 0..12 in whole inches, 193 marks down to 1/16 at 3 px/mm and
never 1/32; clipping, a ruler half off-screen, no wall of marks at any zoom; and the
pinhole scale (600 px at 300 mm and 45 deg is 2.4142). `A10` tilt and depth, from
axis-aligned cases whose answers are known (45, -45, 90, either end first, 3-4-5).

`C1-C10` run it in Chromium: the card; the number in inches on the chip and status
line and back; 300 mm and 304.8 mm; dragging to all four corners and past them;
click-through by `elementFromPoint` and by an orbit that starts under the marks;
and, looking straight down at `box-20mm`, **Zero here on one corner then the corner
20 mm along reads `20.000` on the ruler** (and `0.7874` in), the 20 mm edge spans
`20.000` with tilt 0 and both lamps lit, the piece slides 30 mm and both marks move
30 mm along the ruler, and the 3/4 view puts both lamps out. Re-baking drops the
pick with a reason, and the piece is afterwards still 12 triangles of 8000 mm3.

---

## 6. Beside a live tool

Measure and the ruler can be used **during** a ghost being manipulated or a live
card doing work (Crop's box, the Wheel's handles, Cut's blade, Surface texture,
Foam...) without ending it. Three things used to get in the way, and each has its
own answer.

**Opening the Measure card shut the card in use.** The page has a one-panel rule
(`app-join.js`): opening any drop-down shuts every other, because they all open at
the same spot. Closing a panel ends its session - Cut's cutter, Surface texture's
preview - so Measure ended exactly the work it was meant to serve. Measure's card is
now **the one exemption**, in both directions: opening it shuts nothing, and nothing
shuts it. Every other pair is untouched (D5 checks two other cards still shut each
other). The places that asked "is some other panel open?" (the Join and Subtract
sessions, the toast placement in `app-findings.js`) ignore it for the same reason.

**Two panels at one spot would sit on top of each other.** `app-measure.js` docks
the Measure panel to the *right* of whichever panel is open (`dock()`, kept current
by a mutation observer on `open` and a resize observer on the panels, so a panel
that grows - Gen+ with its Stock shelf - moves it), and puts it back at the shared
spot when it is alone. The panel in use is never moved. Measure's panel is stacked
above the others (`z-index` 96), so in a window too narrow for both it is the one
still reachable.

**A press on a handle must not also be a measurement.** With Measure armed, a press
on a ghost's handle is the ghost's: Crop, Tube edge and Bend stop the event before
it reaches the canvas, the Wheel `preventDefault`s it, and Foam claims a press on its
piece. Which listener runs first depends on when each was bound, so Measure does not
rely on order: it stands down for a press that is `defaultPrevented` or that
`nsoWheelTakesPointer` / `nsoFoamTakesPointer` report as theirs (`claimedElsewhere`).
A press that lands on the piece clear of the ghost is still a measurement.

Arming Measure still turns off the **click-waiting** modes (Paint, Carve, the
brushes, Seat here, Center lock, the Soften and Cap pick) - two of those armed
would fight over one click, and that is unchanged. It no longer clears a **live**
Soften card's face pick, which is a preview rather than a mode waiting for a click.
A tool that arms *after* Measure still turns Measure off, as before.

What to expect while a ghost is up: a press on its body or handles belongs to it
(you cannot measure *through* a ghost), and Esc is heard by both Crop and Measure.

**Validation** - `D1-D5` in `tools/nso_measure_test.js`: a real Crop box, Measure's
card opened over it, armed, the box's `x+` handle dragged with the real mouse (the
box grows 20.00 -> 22.27 and nothing is measured), then two clicks clear of the
ghost measure 40.000 mm and the box has not moved; the ruler dragged with the ghost
up; presses claimed by preventDefault / Wheel / Foam are not measurements and an
unclaimed one is; Cut's live cutter surviving Measure being opened and armed; the
panels side by side, and Measure returning to the shared spot when alone.

