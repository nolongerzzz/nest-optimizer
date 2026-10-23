## The Microscope view - the reference tool, with a way in and a way out (2026-09-20)
Branch `claude/gcode-microscope-io`, off `claude-wip`. Full write-up:
**`docs/GCODE-MICROSCOPE.md`**. Files: `app-microscope.js`, the `#microscope`
block in `index.html`, the `.ms-*` rules at the end of `styles.css`, and two
checks under `tools/gcode-test/`. `nso-gcode-lines.js` and `app-toolpath.js` are
**unchanged** - the plate-side toolpath import and its line scrubber are a
different feature and keep working exactly as they did.

A second rail button, below the G-code one:

> 🔬  `#btn-microscope`, with `#ms-input` beside it

The two are not the same door and should not be merged. `G`🔬 imports a sliced
project **onto the plate** as models you then scrub. 🔬 opens a **dedicated
inspector** - the reference tool's own view - over an STL, a 3MF or a sliced
`.gcode.3mf`, and hands a selection back out. (The rail now paints
undo / frame / X-ray / G / 🔬 / watch; `gcode:entry`'s order check was updated
for it, and its "G directly under X-ray" geometry checks still hold.)

### The audit, short version - the long one is in docs/GCODE-MICROSCOPE.md
The ticket asked whether `docs/reference/joint_microscope_3d.html`'s parsing and
rendering could be adopted wholesale. The two halves have opposite answers:

- **Parsing: there is nothing to adopt.** The reference tool contains **zero**
  G-code parsing code. `SEGMENTS` is a 4.78 MB baked literal of 25,976 moves out
  of one slice, and whatever produced it was never committed. `parseGcode()`
  stays the parser, and it costs nothing, because it **already emits the
  reference tool's exact segment schema**: `x0 y0 x1 y1 z feature layer` by the
  same names, `w` <- `width`, `obj` <- `objectId`, nothing missing, seven extra
  fields. The adapter is one object literal per move.
- **Rendering: yes, reused essentially verbatim.** Every three.js call it makes
  is unchanged between the r128 it loads and the r147 this app serves, and
  `THREE.OrbitControls` is already a global here for the same reason it is
  there. `app-microscope.js` carries it under a `REFERENCE TOOL, LIFTED` banner.

**What blocks lifting the FILE (as opposed to its renderer):** 4.8 MB of baked
data; it builds its own scene/camera/renderer and appends its own canvas to
`#viewport`, which is ours; every identifier is a bare global (`scene`,
`camera`, `controls`, `mode`, `balls`, `animate`); it loads three.js from the
CDN itself; `InstancedMesh` has no `attributes.position` for
`geometryToBinarySTL()` to read; and its axis map is a reflection.

**The one deliberate deviation, flagged rather than done quietly.** The
reference tool's `toThree(x,y,z) -> (x, z, y)` has determinant **-1**. It is a
reflection: it draws every slice **mirrored**. Invisible there - nothing else is
in its scene and its only output is JSON of the original numbers - and not
invisible here, because both new exports would hand back a mirrored part. The
view uses the app's own `zUpToYUp()`, `(x,y,z) -> (x,z,-y)`, determinant +1.
One sign; nothing a user touches changes. (Second, smaller: the camera frames
the loaded file rather than sitting at the fixed distance the reference tool
hard-codes for its own baked part - which its own comment marks unfinished.)

### The finding the ticket's premise did not expect
The ticket contrasts the reference tool's "clean" rendering with
`extrudeFlatLine`'s "blocky one-box-per-move". Those are not comparable objects.

- The **clean** picture is the reference tool's *overview*: `LineSegments`, one
  GL line per move. A line has no thickness, so it can never read as blocky -
  and it is **not geometry**. It cannot be exported.
- The reference tool's *solid* picture, after `Isolate`, is an `InstancedMesh`
  of one 8-sided cylinder per move: **the same one-primitive-per-move
  construction**, round instead of rectangular. Not a different class of
  renderer. And a cylinder is the wrong cross-section for a bead, which is a
  stadium `w` across and `h` tall - the reason
  `docs/GCODE-FEATURE-AUDIT.md` already filed "lines instead of solids" under
  *what was not adopted*.

So swapping renderers does not by itself remove blockiness; drawing lines
instead of solids does. Since the ticket also wants a real object out, and lines
cannot be exported, the split shipped is:

> **The reference renderer draws the view. `extrudeFlatLine` builds the export.**

That honours the out-of-scope line exactly - `extrudeFlatLine` is bypassed *for
rendering*, which was the complaint - and leaves it where it was always right.

### Both selection modes, preserved by calling the code that owns them
Neither is reimplemented.

- **Blob crop** - the reference tool's, verbatim: a box with independent
  horizontal (`r`) and vertical (`h`) half-extents, `defaultR = 5.0`,
  `defaultH = 1.0`, click empty space to drop, blue centre dot to move, a face
  to resize the footprint, orange top dot for thickness, predicate
  `|mx-gx| <= r && |my-gy| <= r && |mz-gz| <= h`. Measured on the real files:
  at `r 5.0`, `h 0.01` takes **1** layer, `h 1.0` takes **7**, `h 5.0` takes
  **23** - which is exactly the thing its own UI text warns about, and exactly
  why it stopped being a sphere.
- **Full layer** - NSO's, verbatim: `NSOGcodeLines.movesAtZ()`, the same call
  the Toolpath card's "whole layer at one Z" scope makes. Keyed on Z, not on the
  layer index, for the bead-hangs-down reason in `docs/GCODE-TOOLPATH-IMPORT.md`.

Downstream they are the same selection object, so Export does not know which
produced it.

### Import: routing by CONTENT, and how a plain mesh degrades
`.gcode.3mf` is not a single extension and cannot be sniffed by name, so the
microscope opens the archive and asks `listPlateGcode()` whether it carries
`Metadata/plate_N.gcode`. **The two routes are provably disjoint** on the
committed files - a sliced project has plate G-code and *no readable model
objects* (`parse3MF` on either real slice: "No objects found in this 3MF"), a
plain project has objects and no plate G-code - so no file can take the wrong
route.

A plain STL/3MF has no features, no layers and no per-move widths, so:

| | sliced `.gcode.3mf` | plain STL / 3MF |
| --- | --- | --- |
| renders as | one `LineSegments` per feature | one `Mesh` per build object; an STL is **one object**, so **one whole unsegmented part** |
| legend | the file's `; FEATURE:` tags | the file's own object names |
| blob crop | per move midpoint | **per whole object** |
| full layer | yes | **refused, with the reason on screen** |

**Full-layer is refused, not faked.** Layers would have to be invented by
slicing the mesh at a made-up layer height, which is the rule
`nso-gcode-lines.js` opens with - *"It is NOT a slicer... it never tries to
predict or reproduce what Bambu Studio would decide"* - and the same argument
that keeps `Travel` out of the feature groups.

**The blob crop takes whole objects, and this was the real open question.** A
box over a mesh's *triangles* yields an open surface patch: no volume, not a
solid, not a thing that prints. This view's export contract is "a real,
standalone object", which the toolpath route meets because `extrudeFlatLine`
makes closed boxes. The repo already has a considered answer for turning a patch
into an object - `app-extract-sel.js` builds it a wall, an inward offset and a
rim, gated by `NSO_edgeStats` - and a second, weaker copy of that reasoning
inside the microscope is exactly the drift this file warns about. So the mesh
route selects at the granularity the **file** has: the build object. For an STL
that is the whole part - the same "one whole unsegmented part" the rendering
gives. For a 10-object 3MF it is a real choice of which parts to take.

### Export: one builder, two doors
Both appear only once a selection is non-empty, and **both build the same
bytes**; only the destination differs.

- **Export to plate** - closes the microscope and lands the selection in the
  main Nest 3D viewport, through `addModelFromZUpGeometry()` + `pushUndo()`,
  the same two calls `NSO_TOOLPATH.extractSelection()` makes. One Undo takes it
  back.
- **Export as STL** - `geometryToBinarySTL()` + `downloadBlob()` from
  `app-core.js`, and the panel stays open.

`microscopeGeometry()` is the single function both call, so they cannot drift -
and `gcode:scope-drive` proves it against the file actually written to disk,
not against a second computation.

### The checks - both in `npm test`
- **`npm run gcode:scope`** (`microscope-check.js`, 52 checks, ~4.5s, no
  browser): the axis determinants, the routing disjointness, the capture-box
  predicate including the independent-extents property, that the layers
  **partition** each real file exactly (no move in two windows, none in none),
  the export triangle counts, and the density numbers.
- **`npm run gcode:scope-drive`** (`microscope-drive-check.mjs`, 103 checks,
  ~31s, headless Chromium): the real view, over **all four file kinds**, with
  every file opened through the real file chooser and never by page script.

Validated on: `supportwithinsupport.gcode.3mf` (2,895 moves, 50 layers, 10
features), `tabletop.gcode.3mf` (**202,877 moves**, 73 layers, 9 features -
**7.8x** the reference tool's baked 25,976, and 2,434,524 triangles as solids),
`flowrate-test-pass2.3mf` (10 build objects) and `box-20mm.stl` (one object,
ASCII; `microscope-check.js` also reads a binary one). Nothing was assumed on
either slice - `meta.assumed` is `false` for both.

**`?v=` — nothing was bumped, rule 4.** `app-microscope.js` is a **new** file
and ships as `?v=scope1`, so there is no cached copy to miss it. `index.html`
itself changed (the rail button and the `#microscope` block) and `styles.css`
gained the `.ms-*` rules; neither carries a `?v=`, so both need whatever cache
handling Grok normally gives the page at merge.
