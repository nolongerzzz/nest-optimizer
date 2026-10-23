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
