## Clear plate is a wipe (2026-10-25)
`app-core.js` (`clearPlateOnly`), `app-supports-card.js` (`forgetAll`). Check:
`npm run clear-plate:wipe` (`tools/nso_clear_plate_wipe_test.js`, Node only; lifts
the real functions into a vm).

Clear plate used to take the copies off the plate and leave every model in
`state.models` (since Import > Recent, with no Pieces row). A cut or an Undo that
lays out `state.models` (`showAllModelsOnPlate`, `layoutUndoModels`) brought them
back, and a reload from Recent added a second model beside the old one. It now
wipes:
- `state.models`, `state.placed`, `state.undoStack` and `state.redoStack` are
  emptied; the Undo and Redo buttons are refreshed (`updateUndoBtn`). Clear plate
  itself is still not undoable.
- every geometry the models, the plate and both stacks named goes through
  `nsoReleaseGeometries` once nothing names it (GEOMETRY LIFECYCLE, app-core.js);
  one the scene still draws stays.
- ids that named a model are reset: `editId`, the cutter (`cutterOpen`, `cutTool`,
  `cutDragging`, `cutT`, `previewMesh`, the blade), the selection, Move's index,
  Join's B / hull / C and faces (`clearJoinSlots`, which also drops the Center lock
  target and Seat here), the stored face pick, the Supports card's host and memory.
- the Pieces card, Optimize, Clone and Remove show their empty-plate state; the
  status line still says the pieces are in Import > Recent.

Getting a piece back is loading it again (From File, From Library, Recent); it is
a new model with a new id (`nextId` is never reset). Recent is not touched.

**Not changed.** Every other caller of `clearPlaced` (cut, Optimize, Join, ...)
re-places pieces and keeps `state.models`. Remove (button, right-click Delete, the
Pieces x) already drops the model with its last copy, and one Undo puts it back.
The plate lock (`state.plateLock`, one flag for the whole arrangement) is not a
model id and is left as it was.
