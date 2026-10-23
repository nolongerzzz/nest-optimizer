## Right-click menu: Undo, Redo, Clone, Mirror, Export, Clear plate (ctx-menu, 2026-10-22)

The menu (`#ctx-menu`): Undo / Redo, Clone, Mirror across X, Export selected as...,
Export plate, Clear plate, Delete piece. It opens on a piece (selecting it) and on
bare plate, where the piece items grey; off the plate there is still no menu. Every
item greys when it has nothing to do (`nsoCtxMenuRefresh`, also called from
`updateUndoBtn`, so it follows the stacks while it is up). Escape and a click outside
close it.

- **Redo** (`app-core.js`, "REDO"). `undoLast()` sets the step it took off aside on
  `state.redoStack` with a snapshot of the plate as it stood just BEFORE the Undo (the
  post-action state - entries only hold the state to go back to). `redoLast()` puts
  that snapshot back and the entry back on `state.undoStack`; the tool is never re-run.
  The snapshot is `state.models` / `state.placed` (fields by value where the app edits
  in place - size, centerOffset, pose; geometry, soups and meshes by reference), the
  paint lists, `plateLock`, `editId`, `selectedIndex`. `pushUndo` and `clearUndo` empty
  the stack (any new action ends the line); so does Clear plate. A plate that is not
  the one the Undo left (`nsoWorldFingerprint`: an upload, an Optimize - anything with no
  Undo of its own) makes Redo stand down, saying so, rather than overwrite it.
- **Not redoable:** an entry with an `onUndone` (G-scope Lift, the Supports card keep
  state a plate snapshot does not hold) and a plate showing the Cut preview. Undoing one
  empties Redo.
- **`undoLastDiscard()`** is the old `undoLast()` with nothing set aside: a tool taking
  back its own live preview (Scale's `putBack`) is not the user's Undo.
- **Keys:** Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y redo wherever Ctrl/Cmd+Z undoes (`app-join.js`,
  not in a text field). **Top bar:** REDO under UNDO, one stack (`#stack-undo`).
- **Clone** is `cloneSelectedModel({ count: 1 })`: one copy, whatever the count box says,
  placed where the existing function puts it (the next free grid cell - not literally
  against the piece).
- **Mirror across X** reflects across the plane through the centre of the piece's extent,
  perpendicular to PLATE X as it lies (`pieceFrame` does not exist yet - it is #261's):
  the soup's X for a piece yawed 0 or 180, its Y for 90 or 270 (tip, flip and tilt-X turn
  about X and change nothing); any other yaw, or a roll that is not a half turn, stands
  down saying so. It is `NSO_mirrorSelectedModel({ axis, plane })`, the Mirror card's own
  path - one `mirrorReplace` Undo, the same gates. **The gates are the card's:** the
  centre plane must be an exact float32 mirror for every vertex, so a piece whose
  centre is not (measured: `pin.stl`, `hinge_knuckle_box.stl`) is refused with the
  card's own message and left alone; centred or on a clean grid it holds (box, cylinder,
  prism, tape, `lid_blank`). Nothing snaps the plane.
- **Export selected as... / Export plate** open the Export card (`#menu-export`, the
  EXPORT button's own: format chooser, cooling profile) with Download selected / Export
  plate in front. The item used to read "Export STL" and call `exportSelected()` with the
  format already chosen; `app-ux.js` no longer binds it, `updateExportFormatUI` no
  longer relabels it.
- **Known, not touched:** Join's Undo leaves the surviving piece at the union's centre
  (x 6 where it was 0, mesh y 10.3 for 10.2) - it is the existing `joinReplace` branch.
  Redo after it is exact.
- Checks: `ctx:menu` (`tools/nso_ctx_menu_drive.js`, real right-clicks), `undo:redo`
  (`tools/nso_undo_redo_test.js`: move, rotate, tip, Cut, Join, new action, keys, stale
  plate, three deep). `?v=`: `app-core.js` leantipb19 -> ctxmenu1, `app-join.js` asis1 ->
  ctxmenu1, `app-scale.js` ringidod1 -> ctxmenu1, `app-ux.js` inside9 -> ctxmenu1,
  `styles.css` reducercard1 -> ctxmenu1. `testStepWeights`: `ctx:menu` 19000 (11s local x
  1.7), `undo:redo` 29000 (17s).
