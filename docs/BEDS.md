# Plates (beds) - the contract

READ THIS FIRST. Every ticket that touches `app-beds.js`, the plate scene in `app-core.js` (`buildPlateMesh`,
`framePlateHome`, the pointer handlers) or anything that reads "the plate" keeps this file current in the same PR.

Plate 2 is an extension for multipart models and, later, print-plate queueing; it is also where an import that
overlaps will land (a later ticket). Queueing and any all-plates behaviour are not built.

## What the user sees

- **+ plate** in the top-right corner of the Plate & Pieces card adds the next bed, up to **six**; at six it is
  disabled. Nothing else on the card moves, renames or restyles. The size picker is every bed's.
- The beds stand in Bambu Studio's order (measured on the `supp_ref` six-plate screenshot): **1 2 3 across the
  back row, 4 5 6 across the front row directly under them**, one equal gap between neighbours in both directions
  (a fifth of the plate's longer side - 36 mm on the 180 mm bed; read off the screenshot it is 48 px on a 240 px bed
  across and 33 px on a 155 px bed deep, 20 % and 21 %, which is Bambu Studio's 1.2 stride). Plate 2 is
  right next to Plate 1, as in G-scope. Each bed has one label under it in G-scope's style ("Plate 1" ...).
- **The active bed has the blue outline** (the cyan the bed has always had); the others' outlines are G-scope's dim
  grey. A new bed becomes active when it is added.
- **A click on a bed's floor, its label or a piece standing on it makes it active.** A drag that starts there orbits
  and activates nothing, exactly as a drag on the floor always orbited; a click on the active bed is as it ever was.
  A click on a piece of the active bed still selects it. A right click on another bed makes it active first (the
  right-click menu's Delete plate acts on the active bed).
- **Everything acts on the active bed** - the Pieces card, Select, Clone, Delete, Lift, Cut, Join / Connect, Crop,
  Foam, Fill, Thicken, Extend, Bridge, Close, Patch, Hollow, Optimize, Import placement, Supports, Slice, Export,
  Measure, Undo / Redo, Clear plate. Export and Slice write the active bed only.
- **Delete plate** (right-click menu, under Clear plate): removes the active bed and its pieces - the wipe Clear plate
  does, for this bed only. No Undo. Disabled with one bed. The beds after it move up one number; the next bed becomes
  active (the previous one when the last was deleted).
- **Moving a piece between beds**: drag it off its bed and let go with the piece over another bed. It keeps its pose,
  lands on that bed's floor where it was let go, joins that bed's Pieces list and that bed becomes active. Let go over
  no bed, or over its own, and it is the move it always was.
- **One bed is the app as it was**: no label, no extra floor, no group, today's border and framing.
- **Camera**: with more than one bed, the home view (◎, Frame, and when a bed is added or deleted) frames every bed -
  up to the full 3 x 2 block - from the front, like Bambu Studio. Changing the active bed moves nothing on screen.

## How it is built (`app-beds.js`)

**`state.models`, `state.placed`, `state.undoStack`, `state.redoStack`, `state.editId`, `state.plateLock` and the
children of `state.modelGroup` ARE THE ACTIVE BED'S.** Every tool already reads those, so none of them can reach a
piece on another bed: the other beds' lists are not there to read. Making another bed active (`swap`) closes every
tool and helper (`nsoHelpers.teardown('plate-switch')`, while the pieces they were drawn on are still the plate's),
stashes the lists and moves the meshes into the old bed's group, loads the new bed's, rebuilds the floors and steps the
camera by the step the beds move.

- **The active bed stands at the world origin**, so every coordinate in the app is the active bed's own and a piece's
  `x` / `z` mean the same wherever its bed sits (G-scope's scheme, `app-microscope.js`). The other beds' groups stand
  at their offsets (`offsetOf`).
- **An inactive bed** is `{ id, group, pieces, floor, models, placed, undoStack, redoStack, editId, plateLock }`:
  its lists and stacks, a group at its offset holding its piece meshes, and its floor (the shared plate material, its
  own grid, a dim border, corner ticks, a label). `state.plateMesh`, `plateGrid`, `plateBorder`, `plateTicks` are
  the ACTIVE bed's floor, built by `buildPlateMesh` as ever; `buildPlateMesh` ends by asking `NSO_BEDS.afterPlateBuilt()`
  to rebuild everyone else's, so a plate-size change follows every bed.
- **Hit-testing.** Everything that lists `state.plateMesh` or raycasts `state.modelGroup` sees the active bed only.
  `NSO_BEDS.pickBed(event)` lists every bed (the active floor, each other bed's floor, label and pieces) and says which.
  `notePress` / `releasePress` (called from `onCanvasPointerDown` / `onCanvasPointerUp`) turn a click on another bed
  into an activation.
- **A piece moves whole or not at all.** A piece with copies of its model on the plate (quantity), with supports, or
  that is a support is not moved between beds - they are tied by id and would be split - and the status line says so.
  A piece that started off its own bed (placed past the edge) is not carried to another by a nudge.
- **Busy.** A job that will put its result onto "the plate" when it finishes must finish on the bed it started on, so
  nothing switches (or adds, or deletes) while `NSO_BoolBusy.active()`, `NSO_SUPPORTS_CARD.busy()`, `state.importsPending`
  (a file being read, parsed or fetched - `handleFiles`, the Library row - or a big piece waiting for its tree), the boolean
  kernel's first download (`NSO_CSG.loading()`) or a drag is running; the status line says why. Moving a piece between
  beds and Undo of that move obey the same rule.
- **Geometry lifecycle.** `nsoReleaseGeometries` also reads the inactive beds' lists and both stacks
  (`NSO_BEDS.stashedRoots()`), so a geometry only another bed names is never disposed.
- **Supports card.** Its memory is keyed by piece id, so another bed's pieces keep theirs; Clear plate / Delete plate
  with other beds standing call `NSO_SUPPORTS_CARD.forget(ids)` for the wiped bed's pieces instead of `forgetAll()`.

## Undo, per bed

Each bed has its own Undo and Redo line (they are swapped in with the bed), so Undo / Redo act on the active bed and
every existing entry, which names pieces by index in that bed's lists, stays valid.

| action | Undo |
|---|---|
| + plate | none (an empty bed; Delete plate removes it) |
| make a bed active | none (not an edit) |
| Delete plate | none, and the bed's lines go with it - like Clear plate |
| Clear plate | none, as before; wipes the active bed's two lines |
| plate-size change | none, as before (pieces come off every bed; the models stay) |
| piece moved between beds | **one step**, two entries that name each other: `bedMoveOut` on the bed it left, `bedMoveIn` on the bed it landed on (each bed's line is its own). Undo on either puts the piece back at the pose and index it left from and makes the bed it left active. It needs the other half to be the last step of its own line - a move cannot be taken back from under later steps on that bed, whose indices it would shift - otherwise it changes nothing and says "Undo the later steps on Plate N first". If the other half is gone (that bed was deleted, or the entry fell off the line) the entry is dropped and it says so. A move is not redoable (like the Supports and G-scope Lift steps). |

## Where a single global plate remains (by design)

`state.plate` / `getCurrentPlate()` - the plate **size** is every bed's; the plate-grid mode and snap; the camera and
its controls; the Recent-files store and the Library (not on a bed); `nextId` (ids are unique across beds, which is
what lets a moved piece keep its id); the Supports card's per-id memory (see above); X-ray (it walks the active bed's
meshes, so another bed's pieces keep the look they had when it was left, until it is made active again).

## Checks

`npm run beds:test` (`tools/nso_beds_test.js`, node only, under a second): the layout and the cap, one bed as it was,
the active-bed switch (lists, Pieces card, meshes, Undo lines, nothing moves on screen), clicks, Clear plate scope,
Delete plate, a move between beds with one Undo (from either bed, refused while the other bed has later steps, dropped
when the other bed is gone), framing, the geometry lifecycle, the busy refusals. No browser step.
