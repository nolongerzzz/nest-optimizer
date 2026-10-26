## Import > Recent, and the Pieces card is the plate (2026-10-25)
`nso-recent.js` (the store), `app-recent.js` (the dropdown), `index.html`
(`#btn-recent`, `#recent-list` under From Library), `app-core.js`
(`handleFiles`, `modelIsOnPlate`, `renderModelList`), `app-library.js`
(`nsoLibrary.load` / `.close`). Check: `npm run recent:store`
(`tools/nso_recent_store_test.js`, Node only).

**Recent.** A third Import entry, opening like From Library: a list in flow under
its button. Entries are the loads of this session, newest first, file or library.
A click loads the piece again - a library entry through the library's own loader
(same fetch, same seating), a file entry through `handleFiles` as From File does.
A piece loaded again is one entry moved to the top, not a second row; 20 are kept.
`handleFiles(files, origin)` records a piece once it has come in (a parse that
fails is not recorded); the library passes `origin` so its loads are filed as
library loads.

**Session only, built to persist.** The store is `add(entry)` / `list()` and an
entry is `{ name, source: 'file'|'library', load, when }`. `load` is the catalog
entry for a library piece and `{ blob }` (the File) for a file. The dropdown
calls only `NSORecent.list()` and waits on a value or a promise, so a store that
keeps entries in browser storage is handed to `NSORecent.use()` and the dropdown
is not touched. Nothing is written to browser storage.

**The Pieces card shows the plate.** A row exists for a model a placed piece comes
from (or the one piece the cutter shows alone). `state.models` is untouched, and
Clear plate still keeps it; the card, Quantity, Optimize and Clone read
`modelIsOnPlate()` instead. The card redraws from `updateAdjustUI` when the set
of plate models changes, so a piece landing on or leaving the plate shows without
each caller saying so.
- Optimize packs, and counts, only models on the plate; its button is off with
  nothing on the plate. Before, Clear plate then Optimize put every loaded piece
  back.
- Clone works on a plate piece only (button and function).
- Clicking a row still selects it.
- Clear plate's tooltip (and the right-click menu's, and its status line) say the
  loaded pieces are in Import > Recent.

**Not done here, done after** ([Clear plate is a wipe](clear-plate-wipe.md)): Clear plate left
the models in `state.models`, now with no row, so a reload from Recent added a new
model beside the old one, and the paths that lay out "every model"
(`showAllModelsOnPlate`, `layoutUndoModels`) brought them back.
