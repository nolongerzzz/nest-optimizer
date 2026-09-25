# The G-code microscope: reusing the reference tool, and the I/O around it

`docs/reference/joint_microscope_3d.html` is a working, standalone G-code
inspector kept in this repo as reference material. This is the write-up of
taking it from a document to a live view inside NSO, and of the import and
export flow around it.

The ticket's framing: **the reference tool's own view is correct and stays as
it is.** The gap is that nothing goes in and nothing comes out. It opens one
baked slice, and its only way out is `Export .json`.

> **Read "G-scope: one tool" first.** It is the current state and it
> supersedes the older sections below wherever they disagree - in particular
> on the second rail button, on the Toolpath card, and on a `.gcode.3mf`
> import adding pieces to the plate. Those are gone.
>
> The corner-drag / camera-mode section above it adds to that. The capture
> box's footprint is no longer one square `r` (see "Blob crop" below for the
> reference's original).

---

## G-scope: corner-drag box and camera modes (2026-09-25)

Branch `claude/gscope-corner-camera`, off `claude-wip`.

### Audit: did corner-drag ever exist?

**No, never.** Checked in three places before building anything:

- **The reference demo** (`docs/reference/joint_microscope_3d.html`) has three
  drag states: `move | resizeR | resizeH`. The first is the centre dot, the
  second a hit on the box *surface* that sets ONE horizontal half-extent `r`
  (a square footprint, uniformly), and the third is the orange top dot
  (thickness, up/down). It has no corner handle and no independent X/Y extent.
- **G-scope as it was on `claude-wip`** (`app-microscope.js`) has the same
  three drag states, lifted verbatim. There was no corner handle and no
  `rx`/`ry`, and `inBox()` tested `r` on both horizontal axes.
- **History**: `git log --all` on `app-microscope.js` and the reference file
  has no commit adding a corner handle or a split footprint, and none removing
  one. The only unmerged branch that touches the file,
  `claude/overhang-point-support`, doesn't add one either.

So this is a gap in the early demo that NSO inherited, not a regression.

### Corner handle: X and Y independently

A **green corner dot** on the box's top face. Drag it and the footprint's
G-code X and Y half-extents follow the pointer **independently** (`rx`, `ry`),
across a horizontal plane at the corner's own height. The box stays centred,
as every other resize keeps it. Details:

- The dot sits on the corner **nearest the camera** and follows it round as
  you orbit. The resize is symmetric about the centre, so which corner carries
  the dot changes nothing about the drag. It draws over the toolpath
  (`depthTest: false`): the corner is usually inside a wall of lines, and a
  handle you can't see is one you can't find.
- Priority on press: centre dot (move) > orange dot (thickness) > corner dot
  (X and Y) > box face (footprint).
- The **face drag** still resizes the footprint. On a rectangle, the longer
  side follows the pointer and the proportion it had when the press began is
  kept, so a square behaves exactly as before.
- `inBox()` is now `|mx-gx| <= rx && |my-gy| <= ry && |mz-gz| <= h`, which is
  the reference predicate exactly when `rx == ry`. `gcodeBoxes()` and
  `selectionRegion().boxes` carry `rx`, `ry` **and** `r = max(rx, ry)`, so an
  existing reader of `r` still gets a box that covers the footprint.
  `addBoxAt(gx, gy, gz, r, h, ry)` takes an optional `ry`.
- The next box dropped takes the last one's shape, as the reference's next
  ball took its size.

Two faults found while driving it, both fixed here:

- **A face press near an edge threw.** The surface raycast was recursive, and
  the box's edge lines are a child of `boxMesh`. At the raycaster's 1 mm Line
  threshold, a press near any edge hit the lines first. No box owns that
  object, so `findIndex` gave -1 and the next pointermove read `balls[-1]`.
  The reference tool has the same fault. The raycast is now non-recursive.
- **A re-frame drifted.** With damping on, OrbitControls keeps adding a
  decaying remainder of the last drag on every `update()`, so a re-frame just
  after a pan slid off its own target. `frameBox()` now spends that remainder
  (one undamped `update()`) before it sets the camera.

### Camera modes: Normal and Close inspection

Two buttons in the View section, `#ms-cam-normal` and `#ms-cam-close`:

| mode | framing | controls |
| --- | --- | --- |
| **Normal** | the whole part (what G-scope opens on and Back returns to) | free orbit, zoom, pan |
| **Close inspection** | tight on the selection's own extent; with nothing selected, the capture boxes; with neither, the whole part | orbit and zoom about it, **pan off**, so the target stays locked on it |

Close inspection is the view Isolate has always put you in, and Isolate still
enters it. What's new is that it's a mode, not a side effect:

- **A camera mode is only the camera.** Switching never touches the
  selection, the boxes, the isolation (detail vs overview), Back, the plate
  or the undo stack. It can be flipped either way at any time: before
  Isolate, inside it, or after Back.
- A filter redraw inside the isolation (the slider, the legend) keeps
  whichever mode, and camera position, you were in. `isolate({ keepCamera })`
  replaces the old save-and-restore of the camera.
- Back returns to Normal. Reopening the panel re-frames in the mode it was
  left in.
- API: `NSO_MICROSCOPE.setCameraMode('normal' | 'close')`, `cameraMode()`.

### Validation

`gcode:gscope-cornercam` (`tools/gcode-test/gscope-corner-camera-drive-check.mjs`,
in `npm test`). It runs 50 checks in headless Chromium, with real mouse drags
and button clicks:

- **Corner drag 1:** 3x3 becomes 6 x 1.5 mm, so X grows and Y shrinks in one drag.
- **Corner drag 2:** it becomes 1.5 x 7 mm. Centre and thickness don't move.
- **Selection:** both times it's exactly the rectangle predicate, recomputed
  in the check from the parsed moves.
- **Orbit:** a real orbit moves the dot to the new near corner and leaves the
  box unchanged.
- **Face drag:** keeps the rectangle's proportion.
- **Camera toggle:** Normal to Close and back, before Isolate, inside it and
  after Back. After every switch, the selection, boxes, isolation, Back
  control, plate and undo stack are compared byte for byte.
- **Close inspection targets:** targeted on the selection's centre, at under
  half of Normal's distance.
- **Pan:** a real right-drag pans in Normal and doesn't move the target in
  Close.

Screenshots `tools/gscope-out/cc-*.png` are each asserted to be a drawn view.

---

## G-scope: one tool (2026-09-25)

Branch `claude/gscope-consolidate`, off `claude-wip`. The microscope is now
**G-scope**, the only G-code tool in the app. Support generation / editing is
out of scope; the selection it would plug into is described in
[The selection seam](#the-selection-seam-where-support-generation-plugs-in).

### 1. Audit - the two entry points, measured in the real app

Driven in headless Chromium against the committed files before anything was
changed:

| entry point | on an empty plate | with a valid `supportwithinsupport.gcode.3mf` | with the same slice renamed `plate.3mf` |
| --- | --- | --- | --- |
| **G**🔬 `#btn-gcode` → `app-toolpath.js` | a file chooser, and nothing else | **10 feature models added to the plate**, the sidebar Toolpath card shown, **the microscope never opens** | refused: "not a sliced project" |
| 🔬 `#btn-microscope` → `app-microscope.js` | the panel **and** a file chooser; with a piece on the plate, the panel over the plate at once, no dialog | opens on it | opens on it (content-sniffed) |
| app Import (`#file-input`, drop) → `handleFiles()` | - | the microscope opens on it **and** 10 feature models are added to the plate underneath | fails: "No objects found in this 3MF" |

So:

- **Which one "pops up right away":** 🔬 `#btn-microscope`. Its click handler
  (`mount()`) opens the panel over the plate with `openPlate()`, falling back
  to the panel plus a picker only when the plate is empty.
- **Why the other forced a manual upload and did nothing otherwise:**
  `#btn-gcode`'s only handler was `NSO_TOOLPATH.openPicker()`, which does one
  thing - `input.click()` on `#gcode-input`. There was no code path in that
  button that did not start with a file dialog, and `onPicked()` then checked
  the **file name** against `/\.gcode\.3mf$/` and, on success, called
  `importSliced3MF()` only. It never called `NSO_MICROSCOPE` at all - the
  auto-landing lived in `handleFiles()`, which this button did not go through.
  Cancel the dialog and nothing happens; pick a file and you get plate models
  and a sidebar card, not the view.
- **Real state of `gcode.3mf` auto-recognition:** partly working. Import did
  land in the microscope, but (a) only for files literally named `*.gcode.3mf`
  - `handleFiles()` sniffed the name while the microscope's own Import already
  sniffed the content - and (b) always as a side effect of the plate import,
  which put one model per slicer feature on the plate first.
- **Feature-level isolation, as found:** the legend's click toggled a group's
  visibility (view only) and the capture box / whole-layer selection existed,
  but a box still caught moves of hidden features, and there was no way to
  turn "only this feature" into a selection. Isolate drew the reference tool's
  8-sided instanced cylinders, which are not what Export writes.

### 2. Consolidated to one tool

Removed: `#btn-gcode`, `#gcode-input`, the sidebar `#toolpath-card`,
`app-toolpath.js`, its CSS, and its two drive checks (`gcode:drive`,
`gcode:entry`). What that door did lives on inside G-scope:

| old Toolpath card | G-scope |
| --- | --- |
| scrub one line at a time, arrow keys | **Pick a line**, ◀ / ▶ and Left / Right |
| Isolate Z (± mm window) | the **layer-range slider** |
| Extract Line / Extract scope | **Export to plate** / **Export as STL** of whatever is selected |
| the whole import on the plate as feature models | nothing on the plate until Export or Crop |

Routing now, one tool whichever way in:

| way in | what happens |
| --- | --- |
| G🔬 rail button (`#btn-microscope`, now labelled G-scope) | open: on the plate if it has pieces, else the panel + a file picker; a file already loaded is reopened |
| app Import / drop / Library box, a sliced project | `handleFiles()` asks `NSO_MICROSCOPE.isSliced(bytes)` - **content**: the archive holds `Metadata/plate_N.gcode` - and calls `openFile()`. G-scope opens on it; **the plate is not touched** |
| app Import, a plain 3MF / STL | the plate, as before; G-scope stays shut |
| G-scope's own Import | `load()`, content-sniffed, as before |

A renamed slice, a dropped slice and a slice picked from G-scope's own dialog
now all take the same route. There is no second importer left to drift.

### 3. "Clear from view" - view only, by construction

**Clear from view** hides the current selection: a plate piece (it joins the
legend's hidden set) or picked / caught lines (a `CLEARED` set of move ids).
**Show all** brings everything back. The same holds for the legend's row
click and its new **only** button, the slider, Isolate / Back and
**Select shown**. None of these functions calls `addModelFromZUpGeometry`,
`pushUndo`, `downloadBlob`, or writes `state.*`; they rebuild the view's own
line buffers or clipping planes and nothing else. `gcode:gscope` proves it by
snapshotting every model id / name / raw-mesh length / vertex count, every
placement (x, y, z, yaw, visibility) and the undo stack before and after, and
counting downloads.

### 4. Line-level and feature-level isolation

- **Line:** `Pick a line` raycasts the overview's own `LineSegments` (line *i*
  of a feature buffer is `userData.segs[i]`, so a pick can only land on a line
  that is drawn) and takes the hit nearest the cursor ray, not the first one
  along it. Shift-click adds / removes; ◀ ▶ step through the moves that are
  drawn, in print order.
- **Rendering reuse, confirmed:** the highlight of a small selection and the
  whole Isolate detail view are `NSOGcodeLines.buildLineGeometry()` -
  `extrudeFlatLine()` per move - the builder Export already used. No new
  geometry. This replaces the reference tool's 8-sided `InstancedMesh`
  cylinders in the detail view, so **what Isolate shows is the solid Export
  writes**, 12 triangles per move (checked against `extrudeFlatLine` to the
  micron, and the downloaded STL triangle for triangle).
- **Feature:** each legend row now has an **only** button (this group alone).
  **Select shown** turns whatever the filters leave on screen into the
  selection, and the capture box now catches only what is drawn - so "only
  Inner wall" plus a box, or plus the slider, gives exactly that feature in
  that region.

### 5. The layer-range slider

Docked to the viewport's right edge: two handles on one vertical track, the
lower (blue) and upper (orange) Z bound. On a slice the steps are the file's
own printing heights (`NSOGcodeLines.zLevels`), so one step apart is one layer
(exactly the moves `movesAtZ` finds), apart is a chunk, the ends are
everything. Drag either handle, drag the band between them to move it, press
the bare track to bring the nearer handle there; on a focused handle
Up/Down/PageUp/PageDown/Home/End, with **Shift** moving the whole window at a
fixed width. **All** resets. On a mesh document (plate / STL / 3MF - no
layers) the steps are 0.1 mm-ish across the part and the view is clipped by
two planes instead. Redraws are coalesced to one per frame.

### 6. Crop - through the Crop tool, not beside it

**Crop out band** removes the slider's Z band from the selection and joins what
is above onto what is below. G-scope does no cropping of its own; every route
ends in `app-crop.js`:

| document | what is cropped | how |
| --- | --- | --- |
| the plate | the one selected piece, **in place** | the view Z band mapped to the piece's raw Z by the offset between them (refused if the piece was tilted, as the Cut-menu Crop refuses a turned one), then `NSO_cropModel(m, box)` - paint stand-down, `NSO_cropRaw`, the in-page canonical checker, the `cropReplace` commit with its undo. G-scope re-reads the plate and stays open |
| a slice | the selection's beads | a dry run of `NSO_cropRaw` + the checker on `buildLineGeometry()`; only if it passes, the selection lands on the plate (`addModelFromZUpGeometry` + `addModels` undo) and `NSO_cropModel` crops it. Two undo steps |
| an STL / 3MF | the selected objects | as a slice, without `shells` |

Two changes to `app-crop.js`, both small:

- **`NSO_cropModel(m, box, opts)`** - the commit half of
  `NSO_cropSelectedModel`, factored out so the Cut menu's Crop row and G-scope
  run one gate and one commit. The Cut-menu behaviour and status line are
  unchanged (`crop:test`, `wire:crop`).
- **`opts.shells`** on `NSO_cropRaw`. A toolpath's beads are *touching closed
  shells*, not one closed solid: stacked layers and collinear moves share faces
  exactly, so the input already carries repeated directed edges (2,940 on 12
  layers of `supportwithinsupport`) and Crop's "no repeated edge" gate could
  never pass. With `shells` the gate is: still closed, nothing degenerate, **no
  more repeated edges than the input brought**, and the unchanged volume gate.
  Measured: without it, every toolpath crop is refused; with it, the seal needs
  no cap at bead boundaries (the in-plane faces pair up), the result encloses
  exactly the volume of the beads outside the band, and a band through the
  middle of beads also seals. `nso_crop_test.js` §7 pins all of that on
  synthetic beads.

Refusals are Crop's own, by name, and nothing reaches the plate first: a band
over the bottom or top is "a trim - use Cut"; a selection wholly inside the
band keeps nothing on one side; a plate crop needs exactly one piece.

**Known limits.** G-scope crops along **Z** only - that is the slider's axis.
X/Y slabs stay in the Cut menu's Crop row (which, conversely, cannot crop along
raw Z). The selection must extend past both ends of the band. A cropped
toolpath piece is still a set of touching bead shells, so the in-page checker
reports non-manifold edges where shells meet (as the uncropped export does);
Crop only gates that it adds none.

### 7. Validation

`npm run gcode:gscope` (`tools/gcode-test/gscope-drive-check.mjs`, **91
checks**, in `npm test`), headless Chromium, real clicks / drags / keys:

- **one tool:** no `#btn-gcode` / `#gcode-input` / Toolpath card /
  `app-toolpath.js` / `NSO_TOOLPATH`; exactly one 🔬 button; the rail button on
  an empty plate (panel + real file chooser → slice opens, plate empty), with a
  piece (no dialog, plate document); `#file-input` with a `.gcode.3mf`, with
  the slice **renamed** `.3mf`, and a real **drop** on the viewport - all in
  G-scope, plate empty; a plain 3MF still goes to the plate and G-scope stays
  shut.
- **view only:** Clear from view on a plate piece, only / Select shown /
  Isolate / Back / Show all, the mesh slider, a refused crop, and everything on
  the slice - the plate snapshot is identical and no download fires (except the
  one STL the test asks for).
- **line vs feature:** a real mouse click at a projected line picks exactly
  that move; → / ← step in print order; its isolated solid and its STL are
  `extrudeFlatLine`'s prism to 1 µm; "only Inner wall" + Select shown is every
  Inner wall move (180) and nothing else; with the slider at 5 layers, exactly
  the Inner wall moves in that band (20).
- **slider:** real drags narrow the range and exactly the moves in the band are
  drawn (one GL line each, none outside); Home collapses to one layer =
  `movesAtZ`; Shift+↑ moves a 5-layer window; All = 2,895.
- **crop E2E:** plate cube 20 → 16 mm in place (`cropReplace`), passing
  `tools/mesh_validate.py` (open 0, non-manifold 0, winding 0, pierce 0), one
  Undo restores it; the slice's Outer wall 15.30 → 12.30 mm (band 3.00-6.00),
  volume equal to the kept beads, open 0, undo `addModels` + `cropReplace`,
  read back in G-scope at the new height, two Undos restore the plate.

Screenshots, each asserted to be a drawn frame by `gl.readPixels`, are written
to `tools/gscope-out/` (git-ignored): `01` a plate piece cleared from view,
`02` a mesh clipped to a Z band, `03` a cube cropped in place beside its twin,
`04` a slice with the slider, `05` one layer, `06` a picked line, `07` it
isolated as a prism, `08` it cleared, `09` one feature alone, `10` the cropped
slice piece on the plate, `11` it back under G-scope.

Updated: `gcode:scope-drive` (the door, the detail view is now prisms: 109
checks) and `gcode:scope-overlay` (the import leaves the plate empty; support
isolated through "only" + Select shown + Export, then read back off the plate
in the slicer's colour: 83 checks); `nso_topbar_accordion_test.js` (the rail
button it checks is `#btn-microscope`).

### The selection seam: where support generation plugs in

Not built - described, so the later phase adds a producer and a consumer, not
a rewrite.

**The data structure.** The selection is one array, `currentSelection`, of
segments (slice) or objects (mesh). Every control that selects - capture box,
whole layer, picked line, Select shown - goes through **one function,
`setSelection(items, source)`**, and nothing else writes it. Isolate, the
highlight, both exports and Crop only read it.

**Reading it: `NSO_MICROSCOPE.selectionRegion()`** returns a plain, view-free
description in the file's own Z-up millimetres:

```js
{
  kind: 'toolpath' | 'mesh',
  source: 'plate' | 'file' | 'objects',
  document: 'supportwithinsupport.gcode.3mf',
  by: 'box' | 'layer' | 'line' | 'visible',
  boxes: [{ gx, gy, gz, rx, ry, r, h }],  // the capture boxes, if any; r = max(rx, ry)
  zBand: [zLo, zHi],                      // the slider's band, in mm
  zExtent: [zLo, zHi],                    // the selection's own extent
  moves:   [/* parsed move records: x0 y0 x1 y1 z width height feature layer index objectId */],
  objects: [/* mesh: { name, positions (Z-up soup), placedIndex, sourceId } */]
}
```

**Listening: `NSO_MICROSCOPE.onSelection(fn)`** calls `fn(region)` on every
change (and returns an unsubscribe). It costs nothing until someone listens.

**Writing it: `NSO_MICROSCOPE.setSelectionMoves(moveIndices)`** selects by
parsed-move index, for a producer that works in moves.

**Where "generate / add / remove a support here" hooks in:**

1. *Here* is `selectionRegion()`: `moves` / `objects` for what was picked,
   `boxes` and `zBand` for where. A "generate support here" action reads that
   and nothing else - it does not reach into the view.
2. The generator is the existing support pipeline (`nso_support_aim.js`,
   `nso_support_tree.js`), fed the region's footprint and Z band instead of
   a whole piece.
3. Its result goes back out through doors that already exist:
   `addModelFromZUpGeometry()` + `pushUndo()` to put it on the plate (what
   Export does), or `NSO_MICROSCOPE.openObjects(label, groups)` to show it
   under the lens as named groups (a tree split into branches, one interface
   layer) with the legend, box, slider, Isolate and Export inherited.
4. *Remove a support here* on a slice is a selection of `Support` /
   `Support interface` moves; today **Clear from view** is its view-only
   stand-in. A real removal needs an editing path that writes - G-code
   rewriting is out of scope, and on the mesh route it is Crop (a Z band) or
   Paint-delete - and must be a new, explicit, undoable action beside the
   view-only one, never a change to Clear from view.

What the later phase should **not** do: keep a second selection store, or
read the view's segment wrappers / `doc.segments` directly. Go through
`selectionRegion()` / `onSelection()` / `setSelectionMoves()`, so the view
stays free to change underneath.

### Files

| file | change |
| --- | --- |
| `app-microscope.js` | G-scope: the selection seam, view filters, Clear from view, line picking, the slider, Crop routing, `isSliced` / `openFile` |
| `app-crop.js` | `NSO_cropModel` factored out; `opts.shells` on `NSO_cropRaw` |
| `app-core.js` | `handleFiles()` routes a sliced project to G-scope by content, not onto the plate |
| `index.html` | one rail button (G🔬, G-scope); the Pick-a-line, Visibility, Crop rows; the slider; `#btn-gcode`, `#gcode-input`, the Toolpath card and `app-toolpath.js` removed |
| `styles.css` | `.btn-gscope`, the slider, the legend's "only"; the Toolpath card rules removed |
| `app-toolpath.js` | **deleted** |
| `tools/gcode-test/gscope-drive-check.mjs` | new, `gcode:gscope` |
| `tools/nso_crop_test.js` | §7, toolpath beads with `shells` |

**`?v=` not bumped** (HANDOFF rule 4). `app-microscope.js`, `app-crop.js` and
`app-core.js` changed together and `app-toolpath.js` is gone, so a browser
holding old copies will mix them: **they need a bump at merge.**

---

## 1. Audit: can the reference tool's pipeline be adopted wholesale?

Asked as two halves, because the two halves have opposite answers.

### Parsing: **no — there is nothing to reuse**

The reference tool contains **zero G-code parsing code**. Not a simplified
parser, not a partial one. `SEGMENTS` is a baked literal:

```js
const SEGMENTS = [{"x0":25.0,"y0":175.0,"x1":90.0,"y1":-1.0,"z":5.0,"w":0.06,
                   "feature":"Travel","obj":null,"layer":0}, ... ];
```

one 4.78 MB line, 25,976 moves, out of one specific slice
(`bambuplabasicgcode.gcode`). Whatever produced it ran somewhere else and was
never committed. Searched the whole file: no `G1`, no `;\s*FEATURE`, no `E`
accumulation, no layer detection, no ZIP reader. There is no parser here to
adopt, reuse or port.

**So `nso-gcode-lines.js` stays the parser, and that costs nothing**, because it
already emits the reference tool's exact segment schema. Measured, not assumed —
every key the reference renderer reads, against a real `parseGcode()` move:

| reference `SEGMENTS` key | `parseGcode()` move | |
| --- | --- | --- |
| `x0` `y0` `x1` `y1` | `x0` `y0` `x1` `y1` | same name |
| `z` | `z` | same name |
| `feature` | `feature` | same name |
| `layer` | `layer` | same name |
| `w` | `width` | **renamed** |
| `obj` | `objectId` | **renamed** |

Two renames, nothing missing, and the move record carries seven more fields the
reference tool never had (`index`, `e`, `length`, `height`, `heightSource`,
`angle`, plus the measured rather than assumed cross-section). The adapter is
one object literal per move.

### Rendering: **yes — reused directly, essentially verbatim**

The ~200 lines of three.js around `SEGMENTS` only ever read a flat array of
segments. Nothing in it is coupled to the baked data. It runs on NSO's
three.js as written:

- NSO serves `three@0.147.0` plus `examples/js/controls/OrbitControls.js` as
  classic globals; the reference tool wants `three@0.128.0` the same way. Every
  API it touches — `LineSegments`, `InstancedMesh`, `EdgesGeometry`,
  `CylinderGeometry`, `Object3D.clear()`, `Plane.setFromNormalAndCoplanarPoint`,
  `Quaternion.setFromUnitVectors`, `Raycaster.params.Line.threshold` — is
  unchanged between r128 and r147.
- `THREE.OrbitControls` is already a global in this app for the same reason it
  is in the reference tool.

`app-microscope.js` carries that code under a `REFERENCE TOOL, LIFTED` banner:
the overview build, `makeBoxVisuals`, `updateBoxTransform`, `addBall`,
`removeAllBalls`, `computeSelectionInfo`, `applyFeatureVisibility`,
`buildLegend`, the three-way pointer drag, `Isolate`, `Back`, `animate` and the
resize handler.

### What blocks lifting the *file* wholesale (as opposed to its renderer)

Six things, all mechanical:

1. **4.8 MB of baked data.** 99.5% of the file is one slice's `SEGMENTS`. You
   cannot `<script src>` it into the app.
2. **It owns the scene.** It builds its own `scene`, `camera`, `WebGLRenderer`,
   `OrbitControls` and appends its own canvas to `#viewport` — which is NSO's
   element, already holding a renderer and an orbit controller.
3. **Bare globals.** Everything is a module-level `const`/`let` in a plain
   `<script>`: `scene`, `camera`, `controls`, `mode`, `balls`, `mouse`,
   `raycaster`, `grid`, `light`, `animate`. All collide.
4. **It loads three.js from `cdn.jsdelivr.net` itself**, inside the file.
5. **Its axis map is a reflection.** See below — this one is not cosmetic.
6. **`InstancedMesh` is not exportable.** `geometryToBinarySTL()` reads
   `geometry.attributes.position` and knows nothing about per-instance
   matrices, so the detail view's cylinders cannot become a file as they stand.

### The one deviation from "exactly as-is", and why

The reference tool maps G-code coordinates to three.js with

```js
function toThree(x, y, z) { return new THREE.Vector3(x, z, y); }
```

That is `(x, y, z) -> (x, z, y)`, whose matrix determinant is **&minus;1**. It is
a reflection, not a rotation: it draws every slice **mirrored**. NSO's own
`zUpToYUp()` is `rotateX(-PI/2)`, i.e. `(x, y, z) -> (x, z, -y)`, determinant
**+1**. Measured both ways, including on the right-handed triad:

```
reference toThree  det = -1   (X x Y) . Z = -1   LEFT-handed
NSO zUpToYUp       det = +1   (X x Y) . Z = +1   right-handed
```

Invisible in the reference tool, because there is nothing else in its scene to
compare against and its only output is JSON of the original G-code numbers. Not
invisible here: this ticket adds "Export to plate" and "Export as STL", and
under the reference mapping both would hand back a mirrored part.

**So the view uses NSO's mapping.** This is the single place the port departs
from "exactly as-is", it is a sign flip in one function, and everything a user
touches — the legend, the box drag, Isolate, Back, the camera — is unchanged.
Flagging it rather than doing it silently: shipping a mirrored export was not an
option, and neither was changing it without saying so.

### The finding the ticket's premise does not expect

The ticket contrasts the reference tool's "clean rendering" with
`extrudeFlatLine`'s "blocky/voxelated one-box-per-move". Those are not
comparable objects.

- The reference tool's **clean** picture is its *overview*: `THREE.LineSegments`,
  one GL line per move. A GL line has no thickness, so it can never read as
  blocky — and it is not geometry. It cannot be exported, and it is not a
  picture of what prints.
- The reference tool's **solid** picture is its *detail view*, after `Isolate`:
  an `InstancedMesh` of one 8-sided `CylinderGeometry` per move. That is
  **one primitive per move** — structurally the same construction as
  `extrudeFlatLine`, round instead of rectangular. It is not a different class
  of renderer.

So swapping renderers does not by itself remove "blocky at real density"; what
removes it is drawing lines instead of solids. And a cylinder is the *wrong*
solid for a bead anyway — a bead is a stadium, `w` across and `h` tall, not a
circle of diameter `w` — which is why `docs/GCODE-FEATURE-AUDIT.md` recorded
"lines instead of solids" under *what was not adopted*.

This matters because Task 4 wants a real object out. Lines cannot be exported.
The resolution the port ships:

> **The reference renderer draws the view. `extrudeFlatLine` builds the export.**

That satisfies the ticket's out-of-scope line exactly — `extrudeFlatLine` is
bypassed *for rendering*, which is what was complained about — while leaving it
where it was always right: it is the measured printed solid, and it is the only
thing in the repo that is exportable as the shape that actually prints.

### Density: what the reference tool was never run at

| file | moves | vs. the baked `SEGMENTS` |
| --- | --- | --- |
| reference tool's baked slice | 25,976 | — |
| `supportwithinsupport.gcode.3mf` | 2,895 | 0.11x |
| `tabletop.gcode.3mf` | **202,877** | **7.8x** |

`tabletop` as one box per move is 2,434,524 triangles. As `LineSegments` it is a
4.9 MB position buffer and draws fine. Both numbers are measured.

A capture-box drag re-runs the predicate over every segment on every
`pointermove`, so 202,877 is the worst case this view has. Measured in the real
app: **3.5 ms per pass**, comfortably inside a frame.
`microscope-drive-check.mjs` asserts it stays under 16 ms rather than leaving it
to inspection.

---

## 2. Both selection modes, preserved by calling the existing code

Neither mode is reimplemented. Each one calls the code that already owns it.

### Blob crop — the sphere-to-box capture region

The reference tool's, verbatim: a box with **independent horizontal and vertical
half-extents**, because of the reason its own UI text gives — *"keep it thin to
avoid grabbing unrelated layers above/below"*. Click empty space to drop one,
blue centre dot to move, a face to resize the footprint, the orange top dot for
thickness, and the predicate is

```js
Math.abs(mx - b.gx) <= b.r && Math.abs(my - b.gy) <= b.r && Math.abs(mz - b.gz) <= b.h
```

with `defaultR = 5.0`, `defaultH = 1.0`. Lifted unchanged, drag handling
included.

### Full-layer selection

NSO's, verbatim: `NSOGcodeLines.movesAtZ(parsed, z)` — every move at one
printing height, whatever feature printed it. That is the same call the existing
`tp-scope: "This whole layer at one Z (all features)"` makes, and it is keyed on
Z rather than on the layer index for the reason recorded in
`docs/GCODE-TOOLPATH-IMPORT.md`: a bead hangs *down* from the nozzle Z, so
testing a bead's span instead of its printing Z would pull every layer into its
neighbour's window.

The two modes are the same selection object downstream, so Export does not know
or care which produced it.

---

## 3. Import: STL, 3MF and `gcode.3mf`, and how a plain mesh degrades

### Routing is decided by content, not by the filename

`.gcode.3mf` is not a single extension and cannot be sniffed reliably by name.
The microscope opens the archive and asks `NSOGcodeLines.listPlateGcode(zip)`
whether it holds `Metadata/plate_N.gcode`. The two routes are provably
disjoint on the committed files:

```
pa_pattern.3mf                  ->  parse3MF: 1 object  (Cube, 12 tris)
flowrate-test-pass2.3mf         ->  parse3MF: 10 objects
tabletop.gcode.3mf              ->  parse3MF: "No objects found in this 3MF"
supportwithinsupport.gcode.3mf  ->  parse3MF: "No objects found in this 3MF"
```

A sliced project carries plate G-code and **no readable model objects**; a plain
project carries objects and no plate G-code. No committed file is both, so no
file can take the wrong route.

### How a plain STL/3MF degrades — the open question, answered

A plain mesh has no `; FEATURE:` tags, no layers, no per-move widths and no
printing order. It has triangles, and — for 3MF — build objects. So:

| | sliced `gcode.3mf` | plain STL / 3MF |
| --- | --- | --- |
| **renders as** | one `LineSegments` per feature, feature-coloured | one `Mesh` per build object, object-coloured. An STL has exactly one object, so it renders as **one whole, unsegmented part** — confirmed, not assumed |
| **legend** | the file's own `; FEATURE:` tags, under the heading *Features* | the file's own object names (`Cube`, `flowrate_m3`, ...) under *Parts*; for an STL, the file name. The heading follows the document, because a plain mesh has no features and the view must not say it does |
| **blob crop** | available, per move midpoint | available, **per whole object** — see below |
| **full-layer** | available | **unavailable**, and the control says why |
| **Isolate** | instanced cylinders per move | the selected objects' own triangles |
| **export** | available | available |

**Why full-layer is refused rather than faked.** Layers would have to be
invented by slicing the mesh at some made-up layer height. `nso-gcode-lines.js`
opens with the rule that forbids exactly that: *"It is NOT a slicer... it never
tries to predict or reproduce what Bambu Studio would decide."* A fabricated
layer would be a fiction with a made-up height, which is the same argument that
keeps `Travel` out of the feature groups. The control is disabled and names the
reason.

**Why the blob crop selects whole objects and not triangles.** This is the part
that was a real design question, so here is the reasoning rather than a default.
A box over a mesh's triangles yields an **open surface patch** — no volume, not
a solid, not a thing that prints. The microscope's export contract is "a real,
standalone object", the same contract the toolpath route meets because
`extrudeFlatLine` produces closed boxes. This repo already has a considered
answer for turning a painted patch into an object — `app-extract-sel.js` builds
it a wall, an inward offset and a rim, and checks the result with
`NSO_edgeStats` before it reaches the plate — and shipping a second, weaker copy
of that reasoning inside the microscope is the drift `docs/HANDOFF.md` warns
about. So the mesh route selects at the granularity the *file itself* has: the
build object. For an STL that is the whole part, which is the same "one whole,
unsegmented part" answer the rendering gives. For a 10-object 3MF it is a real
choice of which parts to take. Either way what comes out is closed if what went
in was.

---

## 4. Export: a real choice, once a selection exists

Both buttons appear only when a selection is non-empty, and **both build the
same bytes** — the difference is only where they go.

| | what it does | reuses |
| --- | --- | --- |
| **Export to plate** | closes the microscope, and the selection lands in the main Nest 3D viewport as a standalone object with undo wired | `addModelFromZUpGeometry()` + `pushUndo()` — the same two calls `NSO_TOOLPATH.extractSelection()` already makes |
| **Export as STL** | writes just the selection to a file | `geometryToBinarySTL()` + `downloadBlob()` from `app-core.js` |

Geometry, in the file's own Z-up millimetres, uncentred — exactly what
`extractSelection()` already hands the ingest path:

- **toolpath** — `NSOGcodeLines.buildLineGeometry(moves)`, 12 triangles per
  move, closed boxes at each move's own measured width and height;
- **mesh** — the selected objects' triangles as read.

`microscopeGeometry()` is the single function both buttons call, so "to plate"
and "to disk" cannot drift apart. `microscope-check.js` asserts they are
triangle-for-triangle identical.

---

---

## 5. The checks, and what they were run against

Both are in `npm test`.

| | `npm run gcode:scope` | `npm run gcode:scope-drive` |
| --- | --- | --- |
| file | `microscope-check.js` | `microscope-drive-check.mjs` |
| checks | 52 | 108 |
| time | ~4.5 s | ~31 s |
| needs a browser | no | headless Chromium |

`gcode:scope` proves the arithmetic, where a failure names a number: the axis
determinants (ours +1, the reference tool's &minus;1), the routing disjointness,
the capture-box predicate including the independent-extents property, that the
layer windows **partition** each real file exactly (no move in two of them, none
in none), the export triangle counts, and the density figures.

`gcode:scope-drive` proves the view. Every file is opened through the file
chooser Chromium really shows, never by calling page script, and it asserts what
the renderer actually built — `LineSegments` for a slice, `Mesh` for a plain
file, `InstancedMesh` after Isolate. Export as STL is checked by re-reading the
file **from disk** and comparing it triangle-for-triangle against what Export to
plate put in `state.models`, so "the two doors write the same bytes" is measured
rather than asserted about one computation twice.

Run against all four kinds the ticket names:

| file | what it is | read as |
| --- | --- | --- |
| `supportwithinsupport.gcode.3mf` | real Bambu slice | 2,895 moves, 50 layers, 10 features |
| `tabletop.gcode.3mf` | real Bambu slice | **202,877 moves**, 73 layers, 9 features |
| `flowrate-test-pass2.3mf` | plain 3MF | 10 build objects |
| `box-20mm.stl` | plain STL, ASCII | one object, one whole part |
| `fixture_sphere_curved.stl` | plain STL, binary | one object, 2,208 triangles |

`meta.assumed` is `false` on both slices — every width and height came out of
the file rather than from a default.

---

## Files

| file | what it is |
| --- | --- |
| `app-microscope.js` | the view. The reference tool's renderer and box-crop interaction, lifted, plus the import routing and the two exports |
| `index.html` | the `#microscope` panel and the `#btn-microscope` rail button |
| `styles.css` | the `.ms-*` rules — the reference tool's own layout, against this app's colour variables |
| `nso-gcode-lines.js` | **unchanged.** Still the parser, still the geometry builder |
| `app-toolpath.js` | **unchanged.** The plate-side import and line scrubber are a different feature and keep working |
| `tools/gcode-test/microscope-check.js` | the selection predicates and the export geometry, under Node |
| `tools/gcode-test/microscope-drive-check.mjs` | the real view in headless Chromium, over all four file kinds |
| `tools/gcode-test/microscope-overlay-drive-check.mjs` | the view as an **overlay** on the plate, the `.gcode.3mf` landing, and the screenshots - see the last section |

### The two rail buttons are not the same door (superseded - there is one now)

> Superseded 2026-09-25 by "G-scope: one tool" above: `#btn-gcode` was
> merged into this view and removed. Kept for the history.

`G`🔬 (`#btn-gcode`, unchanged) imports a sliced project **onto the plate** as
models you then scrub with the Toolpath card. 🔬 (`#btn-microscope`) opens the
**inspector** - over the plate by default, or over one file - and hands a
selection back out. They should not be merged: one adds every feature group to
the plate, the other adds nothing until you choose what to take.

> The section below is later work and supersedes this one on where
> `#btn-microscope` gets its document from.

---

## The overlay: the same view, over whatever is already there

Everything above is about **files**. The view as first shipped could only be
asked what is in one, which made the rail button a door to a file dialog
rather than a tool — and put it out of step with the button directly above it.

**X-ray is the pattern.** `#btn-xray` takes no file, opens no dialog and goes
nowhere: it acts on what is on the plate, lights while it is on, and clicking
it again puts everything back. The microscope panel was already the right
shape for that — `.ms-panel` is `position: fixed; inset: 0`, so it is laid
**over** the main viewport, which is never torn down, and Close puts you back
on the same plate with the same selection. What was missing was the source.

### Three sources, one view

A document's **kind** is what it holds. Its **source** is where it came from,
and the view does not care:

| source | built by | groups are |
| --- | --- | --- |
| a file | `load()` | build objects, or slicer features on a `.gcode.3mf` |
| the plate | `openPlate()` | one per placed piece, read through `meshToWorldSoup` |
| any producer | `openObjects()` | whatever the producer named and separated |

`openPlate()` is `openObjects()`'s first caller and adds nothing to it. That
is deliberate: **`openObjects()` is the seam the support-isolation work grows
through.** A producer that splits one support tree into its branches, or lifts
one interface layer out of a print, hands its named groups to that one call
and inherits the legend, the capture box, Isolate and both exports without a
line changing in this file. Nothing below `meshDoc()` knows, or can ask, who
grouped the triangles.

### Coordinates

`meshToWorldSoup` (app-join.js) is the app's one way to read a placed piece as
world triangles, and it returns the **viewport's** Y-up space. A microscope
document is in the **file's** Z-up millimetres, because that is what the
capture box, the layer window and both exports speak. The remap is the inverse
of `toThree`:

```
three (X, Y, Z)  ->  z-up (X, -Z, Y)
```

so a piece read off the plate and a piece read out of a file land in the same
space, and Export to plate puts one back down where the other would. Measured
in `gcode:scope-overlay`: same triangle count as the plate piece, same size to
1&nbsp;µm, and `minZ` at the 0.3&nbsp;mm hover `placeModelMovable()` gives it.

### A `.gcode.3mf` import lands here

> Updated 2026-09-25: it still lands here, now recognised by content, and it
> no longer runs the plate import underneath - see "G-scope: one tool".

A slice is not a part you position — it is something you go looking through,
and this is the view that does that. So `handleFiles()` (app-core.js) hands
the **already-parsed** result to `openToolpathResult()` once the toolpath
import settles. One parse, not two: the session's own `.result` is passed, not
the bytes.

This is additive. The plate import still runs underneath, so Close drops onto
the Toolpath card with the scrub exactly as before, and `#btn-gcode` is
untouched — it is still the deliberate "put it on the plate and let me scrub"
door, and `gcode:entry` still drives it end to end.

### Features survive the round trip

A `.gcode.3mf` import puts one piece per slicer feature on the plate, named
`<file> - Outer wall` and so on. So reading the plate back gives
**feature-named groups**, and `colorForGroup()` gives a mesh group whose name
ends in a known feature the slicer's own colour for it rather than a palette
slot. Support reads as Support on the plate route too — which is how
`gcode:scope-overlay` takes one support interface layer out of a twelve-group
plate, with none of the model's own walls or infill in it, using nothing
written for the purpose.

### Framing

Two deviations from the reference tool's camera, both on top of the one its
own comment already marks unfinished:

- **the whole part** fits the bounding **sphere**, not the longest edge. Seen
  from a corner a box presents its diagonal, so framing on the longest edge
  crops a compact part off both sides — which is exactly what a piece read off
  the plate is.
- **Isolate frames the selection.** The reference tool only re-targets, on the
  centroid of the capture boxes, and leaves the camera at the whole part's
  zoom; on a twelve-piece plate that leaves one isolated interface a thumbnail
  in the middle of the grid. Isolate *is* the zoom. `Back` re-frames the whole
  part, so it remains the way out. The selection's extent is computed from the
  **document**, not from the detail group, because the toolpath detail group is
  `InstancedMesh` and its geometry bounding box is the unit cylinder every
  instance shares.

### What proves it

`gcode:scope-overlay` (`tools/gcode-test/microscope-overlay-drive-check.mjs`),
81 checks in headless Chromium, and it is the one that takes screenshots —
four of them, each asserted to be a **drawn** view by reading the back buffer
with `gl.readPixels` in the same task as the render, because the canvas has no
`preserveDrawingBuffer` and `drawImage` off it reads blank whatever is on
screen. What it drives:

| | |
| --- | --- |
| the rail button on a plain STL | opens the plate with **no file dialog**, source `plate`, one group per piece, plate untouched underneath |
| the capture box on a plate piece | catches it, misses when moved away, exports its exact triangles |
| Isolate | one `Mesh`, framed on itself |
| Export as STL / Export to plate | the **same** triangles, re-read from disk; one undo entry; `rawAxis: 'zup'` |
| two pieces of one name | two legend rows — the second is made unique, not folded into the first |
| a `.gcode.3mf` through the app's own `#file-input` | the microscope open on it, per-feature colours from `NSOGcodeLines`, layer selection live, **no microscope button pressed** |
| reading that plate back | feature-named groups, the interface isolated alone and put back on the plate as its own piece |

`gcode:drive` pins the same landing from the other side, in the check that
owns the import route.
