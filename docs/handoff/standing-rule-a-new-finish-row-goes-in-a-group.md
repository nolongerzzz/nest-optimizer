## Standing rule — a new Finish row goes IN a group (added 2026-09-18)
The Finish menu is six `<details>` groups plus one footer row, not a flat
stack. It got there because five threads in one night each appended a row to
the bottom without seeing the others: 29 rows, 49 controls and 988px of
content in a 176px column, of which a 720px-tall window could show 63%. An
earlier thread had already capped the body with `max-height` + `overflow-y`
(`styles.css`, `.vp-finish-menu .vp-menu-body`) — keep that, it stops the page
scrolling the canvas under the header, but it is the backstop, not the
structure.

The groups, and what decides which one a row belongs to (shell v3; the
groups are column cards now, and Measure is a top-row drop-down of its own):

| Group | Holds |
|---|---|
| **Shape** | bends the form it has: Smooth, Bend, Tube edge (Flare, Roll, Neck) |
| **Add** | builds material on: Fill / Densify, Foam, Patch, Thicken out / in, Extend, Bridge |
| **Subtract** | takes material away: Subtract B from A, Extract bit, Carve, Hollow, Hollow to safe min, Lift (G-scope's Lift row) |
| **Paint** | the mask itself: Paint Selected / Excluded / Clear, Delete painted, Extract selection |
| **Surface & edges** | edges and faces: Soften, Mirror, Skin face / wrap / patch, Trace raster, Texture |
| **Sculpt** | freehand: the Brush |
| **Check & repair** | finds or fixes defects: Check piece (read-only), Cap open faces, Repair, Seal, Non-solid, Solidify |

*Clear plate* is outside every group on purpose: it is the only control that
is not about the selected piece, and it must never be a click hidden behind a
fold - it is a top-row slab, under Remove.

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
