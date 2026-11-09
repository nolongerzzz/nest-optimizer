## Measure: an Inches toggle, and a draggable 300 mm / 12 in ruler (landed, `app-ruler.js`)

Added 2026-11-09. Full write-up: `docs/MEASURE.md` section 5. Tests: gates A8-A10
and C1-C10 in `tools/nso_measure_test.js` (`npm run measure`).

**What it is.** The Measure card gains **Inches** (prints every length in inches -
chip, status line, ruler marks; the scene and every test-facing number stay mm),
**Ruler** (a level ruler on the screen, 300 mm or 12 in, dragged anywhere in the
viewport by its bar; the rest of it is click-through so the piece under it can be
orbited and panned), **Guides**, **Zero here**, and two more modes in the mode
select: **Align point** and **Align edge**, which use Measure's own snap, edge
chain and anchors and hand the result to the ruler (plumb lines, the span on the
ruler, and tilt / depth lamps).

**The thing to know.** The camera is perspective, so a ruler on the glass is true
at one distance from the camera. It is the surface under the ruler until you pick
something, then the pick. The caption on the bar says which. For an exact reading
look straight down and pick; the lamps say when it is exact. Hover shows no number
for this reason (it read 6 % high on a 20 mm piece).

**Files.** `app-ruler.js` is new (pure geometry at the top, exported for Node; the
overlay below). `app-measure.js` grew the unit layer, the two Align modes and
`window.NSO_MeasureBridge`, the only thing the ruler reads from it. `index.html`
(card rows, script tag), `styles.css`. `tools/nso_shell_v3_test.js` pins updated
for the new controls and options.

**Not done / deliberate.** No keyboard nudging of the ruler (pointer only). One pick
at a time. No fractional-inch readout (decimal only; the *marks* are fractional down
to 1/64). The ruler is never in the scene: not exportable, not swept by
`nsoHelpers`, nothing to bake.

**Pre-existing, unrelated.** `tools/nso_shell_v3_test.js` fails one gate ("CLEAR
PLATE takes every piece off the plate and keeps the loaded pieces") on the branch
tip before this change too.
