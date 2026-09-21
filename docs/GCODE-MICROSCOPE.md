# The G-code microscope: reusing the reference tool, and the I/O around it

`docs/reference/joint_microscope_3d.html` is a working, standalone G-code
inspector kept in this repo as reference material. This is the write-up of
taking it from a document to a live view inside NSO, and of the import and
export flow around it.

The ticket's framing: **the reference tool's own view is correct and stays as
it is.** The gap is that nothing goes in and nothing comes out. It opens one
baked slice, and its only way out is `Export .json`.

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

### The two rail buttons are not the same door

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
