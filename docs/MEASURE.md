# Measure — click-to-measure on the plate

`app-measure.js`, the **Measure** button in the Finish menu, and
`tools/nso_measure_test.js`.

Click two points on the pieces and read the distance between them in
millimetres, or switch to **Edge** and click one edge for its length. The
number is drawn on the piece, not only written to the status line.

---

## 1. The audit: what already picks and what already draws

This tool was written after reading the three mechanisms the app already had,
and it reuses all three rather than growing a fourth. What follows is what
each one does and what Measure took from it.

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

Not its colour, though. `showPlanarHighlight` is cyan and says why it is not
amber: amber next to the paint's yellow is two signals that look like one. That
reasoning holds and rules yellow out here too — but cyan is out as well, and a
screenshot of the first cut is what showed it. `placeModelMovable` gives every
piece a `0x38bdf8` material, so a cyan line drawn **on** a piece is a cyan line
on cyan and all but vanishes; a translucent face wash gets away with it, a 1 px
line does not. Measure is rose (`0xfb7185`) throughout — button, line, end dots
and the chip's border — so the mode and its marks are obviously one thing, and
that thing is neither the piece nor the paint.

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

### what was NOT found

The brief mentioned a shipped **defect overlay** and a **Skin face-select**.
Neither exists on `claude-wip` at `2a6d07a`: there is no defect overlay, marker
or badge layer anywhere in the app, and nothing named Skin. The nearest things
are the four mechanisms above. The conventions reused here are therefore theirs,
and if a defect overlay lands later it should find this file already speaking
its language rather than the other way round.

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

**Render order.** The ladder on a piece is selected outline 12, inspect cage 16,
armed-face highlight 20, paint 40. `app-mask.js` reserves the top for the paint
and explains at length why. Measure sits at **30**: above the three helpers,
below the paint. A measurement drawn across a painted face is the one place the
yellow wins, and that is the rule working.

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

`tools/nso_measure_test.js` B9 pins it: after a full measuring session the piece
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
| mode off | readout null, chip hidden, no object left at renderOrder 30 | clean |
| the piece afterwards | 12 tris, 8000 mm³, 0 painted faces | unchanged |

`npm run measure` runs both halves; `npm test` includes it.
