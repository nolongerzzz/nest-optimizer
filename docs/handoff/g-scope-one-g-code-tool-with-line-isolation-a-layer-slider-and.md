## G-scope - one G-code tool, with line isolation, a layer slider and Crop (2026-09-25)
Branch `claude/gscope-consolidate`, off `claude-wip`. Full write-up:
**`docs/GCODE-MICROSCOPE.md`, "G-scope: one tool"** (it supersedes the
"toolpath import - the entry point" and "two rail buttons" entries below).

- **One tool.** `#btn-gcode` (the G🔬 door that only ever opened a file dialog,
  put a slice on the plate as feature models and never opened the view),
  `#gcode-input`, the sidebar Toolpath card and `app-toolpath.js` are removed.
  The rail button is `#btn-microscope`, now G🔬 "G-scope". A sliced project
  through Import / drop is recognised **by content** (a renamed slice used to
  fail with "No objects found") and opens in G-scope with **nothing added to
  the plate**.
- **View only:** Clear from view / Show all, the legend's "only", Select shown,
  the slider - none writes `state`, the plate or undo.
- **Line isolation:** Pick a line (click, Shift-click, ◀ ▶ / arrow keys);
  Isolate now draws `extrudeFlatLine` prisms - the exported solid - instead of
  the reference tool's cylinders.
- **Layer-range slider** docked right: one layer, a chunk, everything.
- **Crop** the slider's Z band through `app-crop.js`: a plate piece in place
  (`NSO_cropModel`, factored out of the Cut-menu Crop); a slice's selection as
  a new piece, via `NSO_cropRaw`'s new `opts.shells` gate for touching bead
  shells.
- **Seam** for support generation: `setSelection` / `selectionRegion()` /
  `onSelection()` / `setSelectionMoves()` - described, not built.
- Checks: new `gcode:gscope` (91, screenshots in `tools/gscope-out/`);
  `gcode:drive` and `gcode:entry` retired with the door they drove;
  `gcode:scope-drive`, `gcode:scope-overlay`, `crop:test` (§7) and the topbar
  test updated. **`?v=` not bumped - needs a bump at merge** for
  `app-microscope.js`, `app-crop.js`, `app-core.js`.
