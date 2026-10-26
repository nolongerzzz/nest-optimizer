## plates-main - up to six plates, one active, every tool on the active one (2026-10-26)

Contract: **docs/BEDS.md**. Code: `app-beds.js` (new), hooks in `app-core.js`, `app-join.js` (`updatePlateInfo`),
`app-supports-card.js` (`forget(ids)`), `app-library.js` / `handleFiles` (the busy count), `nso_csg.js`
(`NSO_CSG.loading()`), `app-rotate-handles.js` (one guard), `index.html`, `styles.css`. G-scope is untouched. No support,
slicer, packer or import-placement algorithm changed.

**The design in one line.** `state.models`, `state.placed`, `state.undoStack`, `state.redoStack`, `state.editId`,
`state.plateLock` and the children of `state.modelGroup` are always the active bed's; another bed's are kept inside
`app-beds.js` and its meshes in a group outside `modelGroup`. A tool that reads those cannot see another bed, so reads
are safe by construction; what had to be fixed by hand is the WRITE side (a job that finishes after a switch). The active
bed stands at the world origin (G-scope's scheme), so a piece's `x` / `z` are its bed's own.

### Functions that now read the active bed

Everything that reads `state.models` / `state.placed` / `state.modelGroup` / the Undo lines at call time - which is every
tool the ticket names: Select (`selectPlaced`, `pickPlacedIndexFromEvent`), Clone, Delete (`deleteSelectedPlaced`,
`deleteActiveModel`), Lift (`app-lift-plate.js`, `app-grab-drop.js`), Cut, Join / Subtract / Extract bit / Connect /
Center lock, Crop, Foam, Fill and Hollow, Thicken and Fatten, Extend, Bridge, Close, Patch, Optimize (`runOptimize`), Import
placement (`placeNewModel`), Supports (detect, occluders - `others()`, generate, plate-wide), Slice, Export
(`nsoHelpers.exportable(state.placed)`), Measure, Undo / Redo, Clear plate, the Pieces card (`modelsOnPlate`), Watch.

### What still reads a single global plate (not hidden)

- **The plate size and printer**: `state.plate` / `getCurrentPlate()` - every bed is the same size, by the ticket. A size
  change takes the pieces off *every* bed (the models stay), exactly what it does to the one plate today, and only when the
  size really changes (a 3MF restoring the same preset leaves the other beds alone).
- `state.plateMesh` / `plateGrid` / `plateBorder` / `plateTicks`: the ACTIVE bed's floor. Everything that hit-tests them
  (`hitPlateSurface`, `app-connect.js` stroke-on-plate, `app-grab-drop.js` `underMain`, the X-ray skip) sees the active
  bed; `NSO_BEDS.pickBed` is the one that lists every bed and says which.
- The camera and controls, the grid mode and snap, Recent files and the Library (not on a bed), `nextId` (ids are unique
  across beds, which is why a moved piece keeps its id), the Supports card's per-id memory, X-ray (walks the active bed's
  meshes, so another bed's pieces keep the look they had when it was left).
- Placement helpers that use the plate rectangle as "where pieces may go" (`placeNewModel` to the right of the last piece,
  Clone's overflow cell, `nsoFreeSpot`) can put a piece past the edge, over the gap or a neighbour's rectangle. It is still
  the active bed's piece; a nudge-drag of a piece that started off its bed is an ordinary move.
- Lift's carried piece (`app-grab-drop.js`) reads a neighbour bed's floor as "air": it is not moved between beds by a grab.

### Undo, every new action

| action | Undo |
|---|---|
| + plate | none (an empty bed; Delete plate removes it) |
| make a bed active (click, right click, + plate) | none, not an edit |
| Delete plate | none, and the bed's two lines go with it - like Clear plate |
| Clear plate | none, as before (#299 / #300 untouched: the active bed's two stacks, ids and geometries) |
| plate-size change | none, as before |
| piece moved between beds | **one step**: `bedMoveOut` on the bed it left + `bedMoveIn` on the bed it landed on (each bed has its own line). Undo on either puts it back, the bed it left becomes active. It needs the other half to be the last step of its own line, else it changes nothing and says "Undo the later steps on Plate N first"; if the other half is gone (bed deleted) the entry is dropped and it says so. Not redoable. It obeys the busy rule and closes every tool first. |

### Tools and functions checked for non-active-bed access, and what stops them

By construction (they read `state.*` fresh, every raycast is against `modelGroup.children`, which holds the active bed
only): Select, Clone, Delete, Lift, Cut, Crop (plan), Foam, Fill, Hollow, Thicken, Fatten, Extend, Close, Patch, Optimize,
Measure, Mold, Brush, Pull, Seat here, Paint, Position lock, Split to parts, Check, Move, Rotate, Slice (its result is signed
with the pieces' poses and shows "stale" when the active bed differs), Export, Watch, the Supports card (occluders, detect;
its memory is keyed by globally unique ids), G-scope support (the panel covers the window).
Open sessions - every tool that registered with `nsoHelpers` plus the cutter, Join slots, the stored face pick - are closed
before a bed is left (`closeEverything`, the teardown Clear plate uses).

The write side - a job that ends after a switch lands on whichever bed is active - was the real exposure. An independent
read-only audit found these holes in the first version; each is closed:

1. a **move between beds and its Undo** did not obey the busy rule - they do now;
2. the **boolean kernel's first download** (`NSO_CSG.load`, a page the user can click through, not counted by `NSO_BoolBusy`)
   - `NSO_CSG.loading()` is in the rule; Join, Subtract, Extract, Connect, Bridge, Crop copy, Attach, Reattach, Carve,
   Soften / Round wrap and Merge shells all `await` it holding a model;
3. **import continuations** (FileReader, 3MF worker parse, Library fetch + seating) - counted in `state.importsPending`;
4. **a plate-scope 3MF restore** emptied the other beds - only a real size change does now;
5. **a piece moved alone** that is one of several copies of its model, has supports, or is a support - refused, in words;
6. **Undo of a move** did not close tools - it does;
7. **Rotate's 600 ms deferred bake** could fire on a stashed piece - guarded in `seat()`;
8. a right click on an active-bed piece standing in front of another bed - `pickBed` counts active pieces.

The rule: no bed switch, no + plate, no Delete plate, no move and no Undo of a move while `NSO_BoolBusy.active()`,
`NSO_SUPPORTS_CARD.busy()`, `NSO_CSG.loading()`, `state.importsPending` or a drag. The status line says which.

Left as they are, said here: the Export file name carries the piece count read at completion and no bed number; a multi-file
drop is one reader per file and all land on the bed that is active when each finishes (a switch is refused while any is
reading); an Import started on one bed cannot be redirected to another.

### Interpretations to flip if wrong

- **A new bed becomes active** when added (Bambu's behaviour, and G-scope's empty Plate 2 was the active one in the screenshot).
- **With one bed there is no outline *added***: today's cyan border stays; with two or more only the active bed's border is
  cyan, the others G-scope's dim grey. No label with one bed (G-scope never shows one plate).
- **"A drop that is not over any bed leaves the piece where it was dragged from, as today"** is read as: it stays on its own
  bed, at the dropped position, as a free drag always did. "Over a bed" is the piece's own origin (`p.x`, `p.z`), not the pointer.
- The gap is 20 % of the plate's longer side, one gap both ways (Bambu's 1.2 stride; `supp_ref` reads 20 % and 21 %).
- A right click on another bed makes it active before the menu opens (Delete plate acts on the active bed).
- With several beds the home view looks from the front (Bambu's plate view) so 1 2 3 reads left to right; one bed keeps its
  oblique framing.

### Checks

`npm run beds:test` (node only, 0.2 s; registered as a testStep): 12 groups - layout and cap, one bed as it was, the switch,
clicks, Clear plate scope, Delete plate, a move with one Undo (either side, refused while the other bed has later steps,
dropped when the other bed is gone), what cannot move alone, the size change, framing, the geometry lifecycle, the busy
refusals. No browser step. The touching-files run (`--touching` for every changed file, 47 steps) and the real page driven
by hand (add to six, click, drag orbit, drag a piece over a bed, Undo, right-click Delete plate, Optimize / Clone / Export
on bed 2, cutter open when a bed is added, Supports card open when a bed is switched) are in the PR.
