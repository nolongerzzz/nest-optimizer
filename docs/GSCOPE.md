# G-scope - the contract

READ THIS FIRST. Every G-scope ticket from the redo on (round 1a onward) reads
this file before touching `app-microscope.js` and the `app-gscope-*.js` files,
and keeps it current in the same PR: what a ticket changes in the behaviour
below, it changes here. The older per-feature notes (GCODE-MICROSCOPE.md,
GSCOPE-SELECT.md, GSCOPE-FEATURES.md, ...) still hold for what this file does
not cover; where they disagree with this file, this file is right.

Each item says what the user sees, then where it lives and what checks it.

## 1. Two plates, side by side - no toggle (round 1a)

**What it is.** Bambu Studio's multi-plate view. Both plates stand on one floor:

- **plate 1**, the *loaded* plate, on the left - what was loaded: the plate read
  (READ PLATE, or the rail button), or an imported file (IMPORT, or a sliced
  `.gcode.3mf` dropped on the app). It is the only plate anything is loaded
  *into*, and **nothing on it ever changes** by anything done on plate 2.
- **plate 2**, the *second* plate, to its right - starts empty and holds
  **copies** pulled off plate 1. It is a jump point and an export staging area,
  nothing more.

The same size (120 mm, or bigger if what is loaded spreads wider - both grow
together), a plate and a gap apart, each with a small label lying on the floor
in front of it ("Plate 1 - loaded", "Plate 2").

**Active plate.** One plate is active. A **click on a plate** - its floor, its
label, or anything standing on it - makes it active: its outline lights, the
other's dims. A *drag* that starts on the other plate orbits and activates
nothing. **Every G-scope tool, the Features list, the slider, the readouts and
EXPORT act on the active plate.** Nothing on screen moves when the active plate
changes: the plates stay where they stand.

**Copying across.** Press the isolated thing on plate 1 (a piece, a capture
box's region, a line, a line type, a layer, the slider's range - whatever the
Select mode isolates) and drag it over plate 2: past 3 px the copy is in hand,
under the pointer, and it follows the pointer over plate 2's bed (or onto a
piece there, seated at the Seat gap, or into the air). Let go over plate 2 and
it lands there; plate 2 is then the active plate and the copy is selected.
There is no view flip - both plates stay in view the whole time.

- Let go **over plate 1**: nothing is copied ("Let go over plate 1 - nothing
  copied"), plate 1 stays active.
- **Escape** mid-drag: cancelled, nothing kept.
- A press that never travels is a click (it isolates); a capture box's dots keep
  their press; a press on bare floor orbits.
- A piece **on plate 2** is grabbed and dropped as on the main plate
  (`app-grab-drop.js`): on plate 2's bed, onto another piece, into the air.
  Carried over plate 1 it is not put there - let go, it goes back where it was.

What lands is what Export would write: a slice's beads as their prisms (the
moves ride along, so "as solid" still works) or a mesh's own triangles.

**Removed.** The LENS | TAKE toggle, the names LENS and TAKE anywhere a user
reads them, and the shown-plate switch (one plate drawn at a time). The corner
row is **BACK · ◎ · CLEAR · EXPORT · CLOSE**; ◎ (`#ms-btn-frame`) frames both
plates and everything on them, which is also the default view every open
starts in.

**Export follows the active plate.** Plate 1: the Selection (and Sliced piece
while a slice made here is shown), as before. Plate 2: Selected piece (lines
and solid) and **Whole plate** (to the main plate, each piece its own object,
one Undo; or one STL, `Plate_2.stl`).

**How it is built** (`app-microscope.js`, "Two plates, side by side"). The
module variables (`doc`, the selection, boxes, layer range, ...) are the active
plate's; the other plate's are stashed, with its own three scene groups, meshes
and clip planes. **The active plate always stands at the world origin**, so
every coordinate in the file - picks, boxes, clip planes, the grab world - is
the active plate's own, exactly as when one plate was shown at a time; the
other plate's groups and floor are drawn beside it (`placePlates`), and a change
of active plate moves the camera by the same step (`shiftView`). Internally the
plates keep their old keys, `'lens'` (plate 1) and `'take'` (plate 2):
`NSO_MICROSCOPE.plate()`, `showPlate(name)` / `activatePlate(name)`,
`plateOffset(name)`, `plateSide()`, `plateState(name)` (camera in that plate's
own frame), `takePieces()`, `frame()`.

## 2. CLEAR (round 1a)

- **CLEAR** empties plate 2 and makes everything on plate 1 whole again:
  nothing isolated, selected, boxed, cleared from view or switched off in the
  Features list, the slider at All. Plate 1 keeps its document and becomes the
  active plate.
- **Shift-CLEAR** does that and also drops an imported file and reads the plate
  again into plate 1.

Both work from a fresh page (G-scope just opened) and mid-session.

## 3. CLOSE and BACK end the visit (round 1a)

CLOSE, BACK (a producer's way back, e.g. Picture), and every export that leaves
G-scope end the visit **whole**. The next open starts from a fresh read of the
plate - or of the imported file, if plate 1 was showing it (or a slice made
from it) when G-scope closed - with nothing isolated, nothing selected, the
slider at All, the Features list's defaults (Travel off), Toolpath render,
Piece mode, no card open, plate 2 empty and the default view (◎'s framing of
both plates). **Nothing from the previous visit survives except an imported
file**; Shift-CLEAR drops that too.

`close()` throws plate 2 away (`dropTake`), empties plate 1 (`reset`) and keeps
only `importedDoc`; the rail button reopens `importedDoc` with `open()` (which
resets everything about it) or reads the plate.

## 4. The Features list: checkboxes only (round 1b)

**What it is.** The slicer's line types, Bambu-style - swatch, name (count), a
checkbox - and nothing but checkboxes:

- **Shown = the union of the checked rows.** All checked is the whole piece;
  none checked is nothing; checking a row again draws that line type again,
  type by type.
- **A click on the row text toggles its box** (the text is the box's
  `<label>`), and does nothing else. **Hovering a row does nothing.** There is no
  row-click isolate, no hover preview, no snap-back, and a row is not dragged.
- **Whatever is shown is what Select, a drag and Export act on.** A selection
  keeps its moves, but only the checked line types' moves are exported, copied
  onto plate 2 or swept as a solid (`actedOn()`); a press where an unchecked
  type is drawn has nothing to take. Check it again and it is acted on again.
- **Check all** (VIEW card, `#ms-btn-show-all`, the old Show all) checks every
  box - Travel too - and nothing else: an isolation stays, and what was cleared
  from view stays cleared (CLEAR makes a plate whole again).
- One set of boxes for both plates (`FEATURE_OFF`): unchecked on plate 1 is
  unchecked on plate 2.

## 5. The column: IMPORT · READ PLATE | SELECT · VIEW (round 1b)

Every removed button's job, and where it went:

| was | now |
|---|---|
| **OVERHANGS** | Gone from G-scope. Overhang detection is the plate **SUPPORTS** card's. The row (`ms-support-row`, `ms-btn-overhangs`, `ms-overhang-angle`, `ms-support-read`) is deleted; `app-gscope-support.js` still loads but nothing in G-scope switches its markers on (only its `setOn()` API). `gcode:gscope-support` and `support:ui` tested that G-scope UI, not the engine (the engine is `support:*`, `tree:*`, `support:card`, `support:workflow`), so both are **retired**. |
| **RENDER** (Toolpath / Solid) | A row of the **VIEW** card, enabled only while a slice is shown (Slice view on, or a sliced file, which is a slice already); on a mesh it says to turn Slice view on. |
| **SLICE** (nozzle, layer, walls, infill, pattern, support below) | **"Slice settings"** in the VIEW card, under Normal / Slice view. They take effect when Slice view is entered (from a slice: Normal, then Slice view). The two Slice exports (piece to plate / as STL) were already the EXPORT card's "Sliced piece". |
| **CROP Z** ("Crop out band") | **SELECT › Layer**: the slider's range IS the band, and **Take band** (`#ms-btn-take-band`) isolates it as one piece - the Range card's selection (`rangeTarget`) - to drag onto plate 2 or export. No separate card; nothing is cut out of anything any more (`cropZBand` is gone). |

**VIEW card order:** Normal · Slice view | Toolpath · Solid | Slice settings |
Check all · Clear from view · Select shown.

## Checks

| check | what it holds |
|---|---|
| `gscope:take` (`tools/nso_gscope_take_test.js`) | items 1-3: the two plates, click-to-activate, copying across (five kinds), the refusals, plate 2's grab and drop, Export on the active plate, CLEAR / Shift-CLEAR from a fresh page and mid-session, CLOSE / BACK then reopen clean, an import surviving a close |
| `gscope:shell` | the four-button column, the three cards (Select, View in its order, Export), the corner row (BACK · ◎ · CLEAR · EXPORT · CLOSE), the dock, the retired ids gone |
| `gscope:select` | the Select card's five modes; item 4's checkbox contract (two rows checked - exactly those two types drawn; none - nothing; hover changes nothing; the text toggles; Check all; Export and a drag take only what is shown) |
| the #205 set | the older G-scope drive checks (camera, zoom, slice, solid, watch, legend, ...) still hold; `gcode:gscope`'s Crop sections are its Take band section now; `gcode:gscope-support` and `support:ui` are retired (item 5) |
| `page:manifest` | the page loads each script once |

## Not done here

Plate 2 is not saved with the session and has no Undo of its own (CLEAR is the
way to start over). Slice reads plate 1 only. A slice's pieces keep their beads
only until a seat turns them.
