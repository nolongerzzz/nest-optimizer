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
