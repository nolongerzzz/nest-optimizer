# G-scope - the contract

READ THIS FIRST. Every G-scope ticket from the redo on (round 1a onward) reads
this file before touching `app-microscope.js` and the `app-gscope-*.js` files,
and keeps it current in the same PR: what a ticket changes in the behaviour
below, it changes here. The older per-feature notes (GCODE-MICROSCOPE.md,
GSCOPE-SELECT.md, GSCOPE-FEATURES.md, ...) still hold for what this file does
not cover; where they disagree with this file, this file is right.

Each item says what the user sees, then where it lives and what checks it.

## 1. Two plates, side by side - no toggle (round 1a; made the same in round 2b, item 6)

**What it is.** Bambu Studio's multi-plate view. Both plates stand on one floor,
**plate 1** on the left and **plate 2** to its right. They are the same size
(120 mm, or bigger if what either holds spreads wider; both grow together), a
plate and a gap apart. Each has a small label lying on the floor in front of
it ("Plate 1", "Plate 2"). What each plate holds, and how every control acts on
it, is item 6.

**Active plate.** One plate is active. A **click on a plate** - its floor, its
label, or anything standing on it - makes it active: its outline lights, the
other's dims. A *drag* that starts on the other plate orbits and activates
nothing. **Every G-scope tool, the Features list, the slider, the readouts and
EXPORT act on the active plate.** Nothing on screen moves when the active plate
changes: the plates stay where they stand.

**Copying across** is item 11: press the thing on one plate, drag it over the
other, let go - a copy lands there, where it was let go.

**Removed.** The LENS | TAKE toggle, the names LENS and TAKE anywhere a user
reads them, and the shown-plate switch (one plate drawn at a time). The corner
row is **BACK · ◎ · CLEAR · EXPORT · CLOSE**; ◎ (`#ms-btn-frame`) frames both
plates and everything on them, which is also the default view every open
starts in.

**Export follows the active plate, the same on either.**
- **Selection** (or **Selected piece**, on a plate of pieces), and **Sliced
  piece** while a slice made here is shown.
- **Whole plate**, on any plate that holds pieces or a mesh: every piece to the
  main plate (each its own object, one Undo), or as one STL, `Plate_1.stl` or
  `Plate_2.stl`.
- The same content on either plate exports byte-identical files.

**How it is built** (`app-microscope.js`, "Two plates, side by side").
- The module variables (`doc`, the selection, boxes, layer range, ...) are the
  active plate's. The other plate's are stashed, with its own three scene
  groups, meshes and clip planes.
- **The active plate always stands at the world origin**, so every coordinate
  in the file (picks, boxes, clip planes, a drop) is the active plate's own,
  exactly as when one plate was shown at a time. The other plate's groups and
  floor are drawn beside it (`placePlates`), and a change of active plate moves
  the camera by the same step (`shiftView`).
- Internally the plates keep their old keys, `'lens'` (plate 1) and `'take'`
  (plate 2): `NSO_MICROSCOPE.plate()`, `plateDoc(name)`, `showPlate(name)` /
  `activatePlate(name)`, `plateOffset(name)`, `plateSide()`, `plateState(name)`
  (camera in that plate's own frame), `takePieces(name)` (a plate's mesh
  objects; plate 2's by default), `frame()`.

## 2. CLEAR (round 1a; round 2b, item 9)

Item 9: CLEAR empties the active plate and nothing else. Shift-CLEAR is gone.

## 3. CLOSE and BACK end the visit (round 1a)

CLOSE, BACK (a producer's way back, e.g. Picture), and every export that leaves
G-scope end the visit **whole**. The next open starts on plate 1 with:
- a fresh read of the plate, or of the imported file if either plate was
  showing it (or a slice made from it) when G-scope closed;
- nothing isolated, nothing selected, no capture box, the slider at All;
- the Features list's defaults (Travel off), Toolpath render, REGION off (a
  click is the piece's), the ▾ menu and the Export card shut, the Slice
  settings folded and back to the printer profile (item 12);
- plate 2 empty, and the default view (◎'s framing of both plates).

**Nothing from the previous visit survives except an imported file**, and a
CLEAR of the plate that showed it drops that too (item 9).

`close()` empties both plates (`reset`) and keeps only `importedDoc`; the rail
button reopens a copy of `importedDoc` with `open()` (which resets everything
about it) or reads the plate.

## 4. The Features list: checkboxes only (round 1b)

**What it is.** The slicer's line types, Bambu-style - swatch, name (count), a
checkbox - and nothing but checkboxes:

- **Shown = the union of the checked rows.** All checked is the whole piece;
  none checked is nothing; checking a row again draws that line type again,
  type by type.
- **A click on the row text toggles its box** (the text is the box's
  `<label>`), and does nothing else. **Hovering a row does nothing.** There is no
  row-click isolate, no hover preview, no snap-back, and a row is not dragged.
- **Whatever is shown is what a click, Isolate, a drag and Export act on.** A selection
  keeps its moves, but only the checked line types' moves are exported, copied
  across to the other plate or swept as a solid (`actedOn()`); a press where an unchecked
  type is drawn has nothing to take. Check it again and it is acted on again.
- **Check all** (`#ms-btn-show-all`, in the list's own head since round 2c; it
  was the VIEW card's, and before that Show all) checks every box - Travel
  too - and nothing else: an isolation stays as it is.
- One set of boxes for both plates (`FEATURE_OFF`): unchecked on plate 1 is
  unchecked on plate 2.

## 5. The column: IMPORT · READ PLATE | SELECT · VIEW (round 1b; gone in round 2c)

Round 2c took the column away: ONE card holds what it did (item 12). The
round-1b moves below stand, with their homes as they are now:

| was | now |
|---|---|
| **OVERHANGS** | Gone from G-scope. Overhang detection is the plate **SUPPORTS** card's. The row (`ms-support-row`, `ms-btn-overhangs`, `ms-overhang-angle`, `ms-support-read`) is deleted; `app-gscope-support.js` still loads but nothing in G-scope switches its markers on (only its `setOn()` API). `gcode:gscope-support` and `support:ui` tested that G-scope UI, not the engine (the engine is `support:*`, `tree:*`, `support:card`, `support:workflow`), so both are **retired**. |
| **RENDER** (Toolpath / Solid) | A row of the card's **Slice** side (item 12): shown while a toolpath is open (a slice made here, or a sliced file). |
| **True width** (a toggle under Toolpath / Solid, on by default) | Toolpath view only: every extrusion move is also drawn as a bead (`beadMesh`) - a hexagonal section at its real width and height, top at the nozzle Z, the way Bambu Studio draws a slice - so how lines lie and touch can be compared from any side. Moves printed without a stop are one body with mitred joints (no corner notch); a bead that stops, or turns back by more than 100 deg (an infill turnaround), ends in a point. Display only: the thin lines stay on top and are still what is picked and hovered; Travel gets no bead; off, or in Solid, the view is the hairline lines as before. It is not the solid Export writes (that is NSOGcodeSolid). |
| **SLICE** (nozzle, layer, walls, infill, pattern, support below) | **"Slice settings"**, the card's Slice side, folded; defaults from the printer profile. They take effect on the next slice (Normal, then Slice again). The two Slice exports (piece to plate / as STL) were already the EXPORT card's "Sliced piece". |
| **CROP Z** ("Crop out band") | **TAKE BAND**, the card's Slice side: the slider's range IS the band, and Take band (`#ms-btn-take-band`) isolates it as one piece - the Range card's selection (`rangeTarget`) - to drag onto the other plate or export. Nothing is cut out of anything any more (`cropZBand` is gone). |

## 6. The two plates are the same (round 2b)

**What the user sees.** Plate 2 is a second plate 1: its own zone, not a
staging area. Every control acts on the **active** plate and works identically
on either:
- **IMPORT** and **READ PLATE** (IMPORT ▾) load into the active plate, in
  place of what it held. The other plate is not touched.
- The **Features list**, the **slider**, the card (its switch and both sides'
  rows) and **EXPORT** act on the active plate's document, whatever it is.
- A drag copies across in **both** directions (item 11).
- **CLEAR** empties the active plate (item 9).

Nothing needs a drag to plate 2 just to export: each plate exports itself.

**What a plate holds.** Nothing (an empty plate shows "Plate N is empty" and
waits for Import, Read plate or a drag), or one document:
- a plate read;
- an imported file (STL, 3MF, sliced `.gcode.3mf`);
- a slice made here;
- or **pieces**: what drags set down on a plate that was empty, a mesh
  document of pieces (source `'take'`).

A piece copied off a slice keeps its moves, so it can join a slice or be
exported "as solid".

**How it is built.**
- `plateDoc(name)` is either plate's document. Both plates start empty
  (`freshPlate`).
- `open(d)` loads into the active plate. The plate side is what either plate's
  document needs (`sizePlates`).
- The imported file is kept as a copy (`importCopy`), so whatever is set down
  on the plate showing it never reaches the file itself.
- Nothing is gated on which plate is active any more. The Slice card, the range
  card's drag and every Export row read the active document. The checks that
  used to read "plate 2" now read what the document is: `isPieces(doc)`, or
  `hasBeads(doc)` (a mesh holding pieces still made of beads).

## 7. REGION: place, then isolate (round 2c)

**What the user sees.** REGION is a row of the card, on both sides. Its button
(`#ms-mode-select`) arms and disarms the capture box; off, a click in the view
is the piece's.

- Armed, the hover shows the box a click would place - a wire, with what it
  would hold outlined. On a sparse spot of a slice, where no move's midpoint
  falls inside the default box, the box still shows, holding nothing (before,
  the hover showed nothing there, and the click placed nothing).
- **One click PLACES the box** - the default size, or the last box's shape -
  **and does nothing else.** What it holds is the selection, lit; nothing is
  isolated. Another click places another box; the selection is what they hold
  together.
- The box's dots size it (item 8). Sizing isolates nothing either.
- **Isolating is a second, deliberate action**: a click **inside** the box -
  on the box itself, never on a dot - or **Isolate** in the REGION row. Either
  isolates what the boxes hold, taken from the boxes again (a piece moved or
  dropped since may have been selected). Click inside again, or Escape, and it
  is whole again. A click on a piece the box holds but outside the box places
  another box, as any click does while REGION is armed; once something is
  isolated, a click on it makes it whole again whatever REGION is.
- A press inside the box that travels past the slop scales the box's
  footprint, from where it was pressed; one let go in place is the click
  above, and a hand's jitter on the way does not resize the box.
- Where the box would hold nothing, the press is not taken: a drag from there
  orbits, as on bare floor, and a click there still places the box.
- **Escape removes a box that is not isolated** - the last one placed. With no
  box left, Escape disarms REGION, and only then closes G-scope (item 12's
  Escape ladder). **Clear boxes** removes them all.

**How it is built** (`app-microscope.js`). `clickTarget` places a `'box'`
target and returns - it never isolates it. A press inside a placed box
(`boxOwnsPress` → `'face'`) is noted as `view.boxPress`, and `onPullUp`
isolates on a click that never travelled (`isolateBoxes`, which Isolate calls
too); a `'dot'` press never isolates. The box handler's footprint drag
(`resizeR`) waits for the slop and scales from the press. `targetAt`, armed,
answers with the box even when `selectByBox` catches nothing (`items: []`),
and `onPressCapture` leaves such a press to the orbit (`view.regionPress`
places the box on a click). Armed and nothing isolated, the selection under
the pointer is not "the selection" (`selectionTakes`), in `pressTarget`, the
hover and the plate-2 grab alike. `removeLastBox`, `disarmRegion`.

## 8. The handle balls: always on top, always theirs (round 2c)

- A box's three dots - the centre (move, blue), the top (thickness, orange)
  and the corner (X and Y, green) - are **drawn over everything**: no depth
  test, after the hover and the highlight (`renderOrder` 20), like the rotate
  rings. And **never smaller than 6 px** on screen, whatever the zoom.
- **They always own the pointer.** A left press on a dot is a handle drag in
  every mode - REGION armed or not - even with the piece between the camera
  and the dot. It never falls through to the piece: no pick, no pull, no
  isolate. A dot is picked **on screen**, within 10 px of where it is drawn
  (`dotAt`), in the old order where two overlap: centre > top > corner. A
  right press still pans.
- A dot pressed and let go without moving isolates nothing. Over a dot the
  cursor is the grab hand, and nothing new is outlined.

**How it is built.** `makeBoxVisuals` (the materials), `dotsOnScreen` (the
render loop keeps each dot's least size), `dotAt` (used by `boxOwnsPress` in
`onPressCapture`, by the box drag handler and by the hover).
`NSO_MICROSCOPE.boxDots()` gives the dots' screen points, for checks.

## 9. CLEAR empties the active plate (round 2b)

- **CLEAR** empties the **active** plate and nothing else: its document,
  pieces, selection, boxes, isolation, clears and slider (`emptyPlate`). The
  other plate is not touched, byte for byte. The active plate stays active,
  empty, ready for **Import** or **Read plate** (or a drag). The same on either
  plate, from a fresh page or mid-session.
- **Shift-CLEAR is gone**: Shift changes nothing.
- On a fresh open with only plate 1 loaded, CLEAR on plate 1 is the
  start-over: plate 1 empty. If the plate cleared was showing the imported file
  (and the other plate is not), the import is forgotten, so the next open reads
  the plate again.
- The Features set is shared by both plates, so CLEAR leaves it as it is.

## 10. Speed (round 2a)

**What the user sees.** G-scope keeps up with the hand on a real slice: an
orbit runs at the screen's rate, a dragged piece follows the pointer on every
move - across plate 1, over to plate 2, on plate 2 - and a hover or a press
answers within a frame. Nothing is drawn differently for it.

**The contract.**

- **Nothing renders under G-scope.** The panel covers the window, so the main
  viewport's loop (`app-core.js`, `animate`) skips its `render()` while
  G-scope is open. Every other part of that loop still runs, and the plate is
  drawn again on the first frame after CLOSE.
- **A pick never walks a slice.** A feature's line mesh of 20,000 moves or more
  (`LINE_INDEX_MIN`) gets a tree over its segments: `nso_bvh.js`'s tree, built in
  its worker. Its `raycast` runs three.js's own segment test on just the
  segments within reach of the ray, so it picks exactly the line the walk picked.
  Until the tree is ready, it walks. Plate 2's pieces are meshes, so the viewer's
  `Mesh.raycast` already asks the same file.
- **A hover always answers.** Over a big piece (300,000 triangles and up)
  whose tree is still building, `nso_bvh.js` answers a hover's raycast with
  nothing rather than walk every triangle. G-scope's hover (Piece and Region)
  then takes where the ray enters the piece's bounding box (`objectHitAt`), as
  a drag holds such a piece, until the tree is ready. A press asks without
  the hover flag and gets the real surface. `gscope:select` holds it on a
  400,000-triangle sheet with no tree when the pointer comes: one move from a
  G-scope button straight onto the sheet, so that ray is the first to ask for
  the tree, and the outline must say the box answered (`hoverInfo().stand`
  is `'box'`).
- **The pointer's last move always gets its hover, and no older move after
  it.** G-scope hovers at most once per 40 ms (`HOVER_EVERY`). A move inside
  the window is kept as the one pending (a newer move replaces it), and ONE
  timer answers it when the window is up; a timer that fires early waits out
  the rest. The clock is `performance.now()`, and a last-hover time ahead of
  it waits for nothing. A pointer that leaves the canvas, presses or drags
  drops what was pending.
  - Before, every such move armed a timer of its own. A stale timer firing
    within 40 ms of a hover took the newest move and dropped it, so the
    pointer came to rest with no outline, or later painted an older move over
    a newer one.
  - Which mode lost the race depended on the machine's frame and timer timing
    (Region on one software-GL box, Feature and Line on another, Piece here on
    d7abbea). No GPU readback is involved: the hover is plain geometry.
  - `gscope:select` 1b drives both sequences on a fake clock.
- **A piece is built once.** A piece's drawn geometry (a slice's beads as
  12-triangle prisms coloured by line type, or a mesh's own triangles) is kept
  with the piece (`pieceGeometry`). A redraw of its plate (a pull, a drop, a
  click that activates it) hands the same geometry to the new mesh. A piece
  moved on the bed keeps it too, and the mesh stands where the piece went
  (`userData.base`). It is rebuilt only when what it is drawn from changes: a
  seat that turns the piece, or a line type switched on or off. A pull's copy is
  drawn from the prisms the pull already built (round 2b: the ghost, item 11), not from a
  second build. The hover outline of a bead piece is each prism's 12 box edges,
  read straight off its triangles, and is kept too.
- **The prisms are built in typed arrays.** `buildLineGeometry` (nso-gcode-lines.js)
  writes straight into a Float32Array, value for value what it wrote before
  (`gcode:lines-build` holds the two equal on every move of both committed
  slices). Plate 2's normals, bounding box and sphere are made in flat passes,
  to the same values three.js would compute, and its line-type colours are
  bytes.
- **A pull's copy is grabbed where the ray enters its box** while it has no
  tree, not by a walk of its triangles. Its tree is asked for when it is set
  down, so the next press on it does not walk either.

**Measured** (`gscope:speed`, 1280 x 800, `tabletop.gcode.3mf` standing in for
the user's file - 202,877 moves; main-thread milliseconds, headless Chromium):

| | 346bc38 (before round 1) | d7abbea (round 1) | round 2a |
|---|---|---|---|
| main viewport renders under G-scope | every frame | every frame | never |
| orbit, main thread a frame | < 1 | < 1 | < 1 |
| orbit on the small slice, frames a second | - | 14 | 49 |
| pick - the selection pass (med / max) | 19 / 33 | 22 / 36 | 1.5 / 2.6 |
| hover, a pointermove (max) | 51 | 61 | 17 |
| click: select and isolate the piece | 177 | 92 | 60 |
| the move that starts a pull (202,877 moves copied) | 2,765 | 2,919 | 972 |
| mousedown to the copy's first frame | 2,438 | 2,308 | 927 |
| let go over plate 2 | 1,815 | 2,067 | 380 |
| press on a plate 2 piece | 275 | 267 | 11 |
| a move with the piece in hand (max) | 1 | 6 | 0.5 |
| moves that followed, of 60 (pull / plate 2) | 59 / 58 | 59 / 58 | 59 / 58 |

Round 1 did not make G-scope slow: 346bc38 and d7abbea measure the same. The
slowness was the full rebuilds and walks above, and they predate the two plates.
The frame rate on tabletop in this box is SwiftShader's (a software GPU), about
6 fps whatever the code does, so the gate holds the main thread's share of a
frame there (2a, <= 33 ms). On the small committed slice
(`supportwithinsupport.gcode.3mf`) the main thread's share is gated at <= 2 ms
(2b), and its frame rate over tabletop's at >= 5.2 (2c, `ORBIT_RATIO_MIN`,
the two orbits measured back to back): both drawn by the same software GPU on
the same box, so a starved runner slows both and the ratio holds, where a
">= 30 fps" floor read the runner's speed. Each frame rate is logged as a
finding (ticket ci-timing-gates).

**Checks.** `gscope:speed` (`tools/nso_gscope_speed_test.js`) measures and gates
the items above. It uses `tools/fixtures-local/baseline.gcode.3mf` when that
file is there (the user's, git-ignored), else `NSO_GSCOPE_SPEED_FILE`, else
tabletop; `NSO_GSCOPE_SPEED_ROOT` points it at another checkout for a before /
after. `gcode:lines-build`
(`tools/nso_gcode_lines_build_test.js`) checks the typed-array prisms against
the old build, bit for bit.

## 11. The drag: a ghost, both ways (round 2b)

**What the user sees.** Press a thing on one plate (a piece, what the capture
boxes hold, an isolation - a band Take band took, say - the slider's range) and
drag. Past 3 px
a copy of it is in hand, **drawn under the pointer on every frame of the
way**: over the plate it came from, across the gap, over the other plate. It
slides on whichever bed is under the pointer, seats onto a piece of the other
plate, or floats in the air. Let go and it **lands exactly where it was let
go** - no jump, no pop-in. The plate it came from is not changed. The other
plate is then active, with the copy selected.

- Let go **back over the plate it came from**: nothing is copied ("Let go
  over plate N - nothing copied"), and that plate is active again. **Escape**
  mid-drag: cancelled, nothing kept.
- A **piece** on a plate (one a drag set down there) is grabbed instead: it
  *moves* on its bed, onto another piece (seated at the Seat gap), into the
  air - the main plate's grab (`app-grab-drop.js`). Carried over the **other**
  plate's bed and let go, it is **copied** there, where it was let go, and it
  stays where it was too. This is how a piece goes plate 2 → plate 1.
- A press that never travels is a click: it isolates (REGION armed, it places
  a box - item 7); a capture box's dots always keep their press (item 8); a
  press on bare floor orbits.

**Where it lands.**
- **An empty plate** becomes a plate of pieces.
- **A plate holding a mesh** (pieces, a plate read, an imported STL / 3MF) gets
  one more piece.
- **A plate holding a slice** gets the piece's **moves**: they join the slice
  as one more object, drawn as its lines, with new move numbers and runs of
  their own, and the layers and slider steps are made again (`appendToSlice`).
- A piece with no moves (a mesh, or one a seat turned) cannot join a slice:
  refused, nothing copied.

**How it is built.**
- `pullSpec` reads the thing pressed: a slice's moves as their prisms, a
  mesh's triangles, or bead pieces' shown moves.
- `makeGhost` draws it once, as it will land (prisms in line-type colours,
  or the piece colour), in the scene itself, its footprint centre and bottom
  at the mesh's origin.
- At the slop the other plate becomes active (nothing on screen moves) and
  `ghostWorld` carries the ghost. `pieceWorld` carries a grabbed piece.
- Both answer `underCarry`: the active plate's pieces to seat onto, then
  **either plate's bed** (so the carried thing never leaves the pointer), then
  the air.
- On release `setDownOn` lands it at the ghost's position. On a mesh plate the
  ghost's geometry *is* the piece's from then on (nothing rebuilt, so nothing
  moves).
- `copyAcross` does the same for a grabbed piece let go over the other plate.

## 12. One card (round 2c)

**What the user sees.** The left column is gone. One card stands top-left,
always:

```
┌─────────────────────────────────────────┐
│ [ IMPORT ▾ ]      Normal ○━━● Slice      │
│─────────────────────────────────────────│
│  selection options for the current side  │
└─────────────────────────────────────────┘
```

- **IMPORT** opens a file into the active plate; it stands where the main
  page's Import slab stands, so it does not move as G-scope opens. Its **▾**
  holds **READ PLATE** - the backup: opening G-scope from the plate already
  brings the plate. Both load into the active plate (item 6). The ▾ menu shuts
  on a choice, a press outside it, Escape or CLOSE.
- **The switch is the view**: Normal (the mesh) | Slice (the toolpaths). The
  document decides its side: a toolpath - a slice made here, a sliced file,
  moves set down into a slice - is the Slice side; a mesh, pieces or an empty
  plate is the Normal side. Slice on a mesh slices it with the Slice settings
  as they stand; Normal on a slice made here goes back to its mesh, whole
  again; Normal on a mesh re-frames; a sliced file has no mesh, so Normal is
  off there. The track between the two flips it too. **Flipping it changes the
  rows**:
  - **Normal side**: REGION (item 7) · WHOLE PART (back out of any isolate).
  - **Slice side**: REGION · TAKE BAND (the slider's range isolated as one
    piece) · Toolpath | Solid · Slice settings (folded) · MEASURE (folded,
    item 13) · PLAY (folded, item 15); BACK (item 14) stands beside the card's head. An isolation there is undone by Escape, or a click on it.
- **Slice settings**: nozzle / layer / walls / infill (and its pattern) /
  support below. Their defaults are the **plate's printer profile**: on the A1
  mini a 0.4 mm nozzle and 0.2 mm layers (the owner's own Bambu slice:
  `fixtures/supports/top_clip_x2_supports.gcode.3mf`, "Bambu Lab A1 mini 0.4
  nozzle", "0.20mm Standard @BBL A1M"); on any other printer the app's 0.4
  nozzle and half of it. Walls 2, 15 % grid and support below 30° are that
  profile's. They are set from the profile at the start of every visit, an
  edit lasts the visit, and they take effect on the next slice (Normal, then
  Slice again), as before.
- The **Features list** stays bottom-left (checkboxes only, item 4; Check all
  in its head), the **slider** on the right, the **corner row** top-right. The
  left wall stays under the card whichever side it shows.
- **Escape**, one step at a time: the open ▾ menu or Export card shuts → an
  isolation is whole again → the last box not isolated goes → REGION disarms
  → G-scope closes.

**Every job a removed control did, and where it is now.**

| was | now |
|---|---|
| SELECT › Piece | a click / drag in the view (the default) |
| SELECT › Feature | the Features list: what is checked is what a click, Isolate, a drag and Export take |
| SELECT › Line | hovering a move of a slice reads it out in SELECTION / SEGMENT INFO ("Move N - feature, layer, Z, width x height, length, angle"); isolating one move is dropped (`pickLine` / `stepLine` stay in the API) |
| SELECT › Layer | the slider (one step is one layer) + TAKE BAND |
| SELECT › Region | the REGION row, both sides (item 7) |
| VIEW › Normal / Slice view | the switch |
| VIEW › Toolpath / Solid, Slice settings | the Slice side's rows |
| VIEW › Check all | the Features list's head |
| VIEW › Clear from view | the corner CLEAR, which empties the active plate (item 9). Hiding a selection from view has no button now; `clearFromView()` is the API's |
| VIEW › Select shown | gone: what is shown is what is acted on, and TAKE BAND at All takes everything shown (`selectVisible()` stays in the API) |
| READ PLATE | inside IMPORT ▾ |

**How it is built.**
- `index.html` `#ms-main-card`: each row names the sides it shows on
  (`data-on`), the card names its side (`data-side`), and CSS shows the
  side's rows. Every control with a new home keeps its id (`ms-btn-open`,
  `ms-btn-plate`, `ms-cam-normal` / `ms-cam-slice`, `ms-mode-select`,
  `ms-btn-isolate`, `ms-btn-clear`, `ms-btn-back`, `ms-btn-take-band`,
  `ms-render-*`, `ms-slice-*`, `ms-btn-show-all`): Watch and the plate-side
  checks find them by id.
- `app-microscope.js`: `cardSide()` / `syncCard()` (from `syncPlate` and
  `redrawDoc`), the Shell's `SHELL_CARDS` (the ▾ menu and Export: one open
  at a time), `watchCard` (publishes `--ms-card-bottom` for the left wall and
  the support pop). The modes are Piece and Region only.
- `app-gscope-slice.js` owns the switch (`syncToggle`), the settings
  (`profileDefaults`, `seedSettings`, `setSettingsOpen`) and the Slice report.

## 13. MEASURE: the numbers, shut until asked for (round 3a)

**What the user sees.** One more row on the Slice side of the card, last, as a
single quiet line - `▸ MEASURE` - the way Slice settings is. Shut, it shows
nothing and computes nothing. A click opens it:

- a line of totals for what is measured - the selection, or with none, the moves
  the Features list and the slider leave drawn: moves, mm, layers, Z range and the
  average move;
- a row per line type (moves, mm), longest first;
- **Layers**: a row per layer and support line type - runs, long lines, mm,
  angle, line pitch, footprint - a table that scrolls inside the card, folded
  until pressed;
- **Copy report**: all of it as plain text on the clipboard;
- a line that names the line types ONE plate has and the other has not (the whole
  of each plate, not the selection) - a type a slice never makes is the kind of
  difference the eye misses.

It stays shut by default and is never in the way: no table is drawn until it is
asked for.

**How it is built.** `nso_gscope_measure.js` is pure (no DOM): `summarize`,
`layerRows`, `compare`, `report`. The card calls it from `syncMeasure()`
(`app-microscope.js`), re-run on a selection, the slider or a document change
only while the row is open; the checks call the same functions, so a number read
off the card is a number a test holds. A *run* is moves laid without lifting (each
starting where the one before ended); a *long line* is a straight stroke of
2 mm or more; the pitch is read across the dominant direction. The numbers are the
ones the support-interface work used against Bambu's reference slice - on its flat
head: 2 runs a layer, about 259 mm, pitch 0.46.

The parser is the viewer's own (`NSOGcodeLines`), which flattens Bambu's arc
moves (G2/G3); a reader that skips them undercounts Bambu's slices - the
reference's Support line type is 35 499 moves in the viewer, 8 665 when arcs are
skipped.

## 14. BACK: one step back, beside the card (round 3b)

**What the user sees.** A button, `↩ Back`, just right of the card's head, level
with its top (the corner row is for leaving and framing; this is for the view).
Grey at the starting point. Each change the user makes to the view leaves one step
behind it, per plate, and a press takes the latest one back:

- isolating a piece, a band or a box's contents (it is whole again; the selection
  stays);
- placing a capture box (the last one goes), arming REGION (it disarms);
- opening a card or a row: Export, the IMPORT ▾ menu, Slice settings, Measure and
  its Layers table (each shuts);
- moving the layer-range slider (one drag is one step; it goes back to where the
  drag began);
- checking or unchecking a line type in the Features list.

It never closes G-scope (Close does), never touches what a plate holds - a copy, a
CLEAR, an Import and a slice are not view steps - and a step already undone another
way (Escape, the row's own button) is skipped, so a press always changes something
or the button is grey. Escape's chain (item 12) is unchanged. The stack is per
plate, emptied when a plate is emptied or a file replaces it.

**How it is built.** `pushStep(undo, kind)` / `stepBack()` in `app-microscope.js`
(exported with `clearSteps`, `stepCount`); the changes above call `pushStep` at the
point they happen, and Slice settings (`app-gscope-slice.js`) through the API. Undoing
replays through the same setters with pushes switched off. Checked in
`gscope:shell` (its position beside the card, grey at the start, three steps undone
in reverse order, a skipped step, a line type's check and an isolate).

## 15. PLAY: a layer, move by move (round 3c)

**What the user sees.** One more folded row on the Slice side, `▸ PLAY`, under
Measure; shut it shows nothing and draws nothing. Opened, it plays **the slider's
top layer** (one step is one layer) the way Bambu Studio's horizontal move slider
does, with a play button:

- **◀ · Play/Pause · ▶** and a speed (25 / 100 / 400 / 1600 moves a second), and a
  **scrubber** across the layer's moves in the order the nozzle printed them;
- the played part is drawn over the view in bright lines that fade with age (the
  last 80 moves are the trail), a **dashed line where the nozzle jumped** between
  runs, and an orange marker on the nozzle - on top of everything, so a buried
  layer is still readable;
- a readout: `Layer, Z - move N of M`, then the move's line type, X / Y, length and
  its **G-code line** (each move now remembers the line it was read from), and how far
  it jumped to start a run.

A new layer (the slider moved, the other plate made active) shows the whole layer,
scrubber at the end, until Play is pressed - Play from the end starts again from 0.
Isolated, it plays the isolation's own moves on that layer. Dragging the scrubber or pressing ◀ ▶ pauses. It changes nothing: the document, the
selection and the Features list are as they were. BACK shuts it (item 14); a
document change or CLEAR shuts it too.

**How it is built.** `app-microscope.js`: `playLayerMoves` (the segments of the
top step, in file order), `playDraw` (a group of two `LineSegments` and a sphere,
positioned by the active plate's offset), `playSeek` / `playRunSet` (a
`requestAnimationFrame` clock), `syncPlay` (called with the slider and the card).
`nso-gcode-lines.js` puts `line` (1-based) on each move. Checked in `gscope:shell`
(shut by default; a real click opens it on the top layer; the scrubber at 0 and
at 10; Play runs to the end and stops; BACK shuts it).

**Not here yet.** Edits on a layer (snip, a detour) and playing a draft through GRISPR's
verifier are the next rounds; Play is the layer they will be drawn and checked on.

## 16. The slider's top handle, between layers (round 3d)

**What the user sees.** Drag the **top handle** of the layer slider on a slice and the
piece is printed as the handle goes up: every layer under it whole, the layer it stands
in drawn **up to the nozzle** (the moves the handle has passed, in print order), a nozzle
marker and a fading trail on the last of them, nothing above. Isolated, it is that
isolation's own moves - one piece, bottom to top, the way Play shows one layer. The
handle no longer snaps to layers: layer k stands over k/n - (k+1)/n of the track, and the
place inside it is how far through the layer's moves the nozzle is. The label reads
`Z 8.20 - 50%` and the count `40.5 / 100 layers`. The top of the track is the last layer
whole. The handle rests where it is let go (pause the print mid-layer); a step by key, the
`All` button or the band drag makes the top layer whole again. The bottom handle, the
keys and Take band are by layers as before - Take band on a part layer takes what is
drawn.

**How it is built.** `zr` gains `part` (under 1 = part drawn) and `t` (where the handle
stands on the track); `setZHead(f)` is the pointer's way in, `setZRange(lo, hi, part, t)`
the general one (callers that move by layers are unchanged). `inMainRange` is every
whole layer - what the overview and the isolation are built from, rebuilt only when a
layer is crossed - and `inZRange` adds the part layer's drawn moves, so Take band,
Measure and the hover count what is drawn. Inside a layer only `drawScrub` runs: the
layer's first moves as lines (and beads, under True width) plus `trailGroup` - the
nozzle and trail Play draws, now a function both use - so a frame is a layer's worth of
lines, not the piece's (about 11 ms a frame on a 107,000-move slice; a layer crossing
costs what a layer step always did). With Play's row open the nozzle is Play's own and
follows the handle. The drag is one BACK step (item 14), which puts the handle back
where it stood. Checked in `gscope:shell` (a whole layer has no part layer; the handle
half way up draws the layer's first moves and the nozzle; further up the same layer draws
more, still one BACK step; the top is whole; isolated, it scrubs the isolation's moves;
BACK; a step by layer makes the layer whole).

**Not here yet.** The bottom handle is by layers; scrubbing a piece through the Play
row's speed (a piece-long Play button) is the next small step.

## Checks

| check | what it holds |
|---|---|
| `gscope:take` (`tools/nso_gscope_take_test.js`) | items 1-3, 6, 9, 11, 12: the two plates and click-to-activate; drags 1 -> 2 with the ghost under the pointer on every move and the copy landing exactly where let go; drag 2 -> 1 onto a plate read and into a slice; the refusals; grab and drop on a plate; Import, and IMPORT ▾ → Read plate, onto the active plate 2; the same content exporting byte-identical files from either plate; CLEAR on each plate emptying only that plate, from a fresh page and mid-session; CLOSE / BACK then reopen clean (REGION off, the ▾ menu shut, the settings folded); an import surviving a close |
| `gscope:shell` | item 12: the column gone and the card present on open; IMPORT at the main page's Import spot; IMPORT ▾ → Read plate into the active plate; the switch flipping the view and the rows (Normal 2, Slice 4); the Slice settings folded, at the printer profile's 0.4 / 0.2; every removed control's job at its new home; the corner row (BACK · ◎ · CLEAR · EXPORT · CLOSE), the Export card, the dock clear of the card; the retired ids gone; shots of the card on both sides |
| `gscope:select` | items 7, 8, 10, 12: the hover's clock on a fake clock; every hover waited for (up to 2 s, the failure says how long); REGION - click places a box, nothing isolated; a dot dragged resizes it, nothing isolated; a click inside / Isolate isolates exactly what it holds; Escape removes it; a dot behind the piece still takes the mousedown, in either mode; Region's hover where no move midpoint falls in the box; a big piece's hover answering while its tree builds; Piece in the view, a move's readout on hover, a layer by the slider + Take band; item 4's checkbox contract (two rows checked - exactly those two types drawn; none - nothing; hover changes nothing; the text toggles; Check all; Export and a drag take only what is shown) |
| `gscope:measure` (`tools/nso_gscope_measure_test.js`) | item 13: a made zigzag reads back as one run at its pitch and angle; a row per (Z, feature); a feature only one side has is named; every move of a real slice counted once; with `NSO_MEASURE_REF=<supp_ref.gcode.3mf>` the reference's flat head reads 2 runs a layer, about 259 mm, pitch 0.46. The row's own gate is in `gscope:shell` (shut by default, a real click opens it) |
| the #205 set | the older G-scope drive checks (camera, zoom, slice, solid, watch, legend, ...) still hold, driven through the card; `gcode:gscope`'s Crop sections are its Take band section now; `gcode:gscope-support` and `support:ui` are retired (item 5) |
| `gscope:speed` | items 10 and 11: a 60-move drag follows on plate 1, across and on plate 2; the ghost drawn on every frame of a pull; orbit (the main thread's share of a frame: <= 33 ms on the file, <= 2 ms on the small slice; the small slice's frame rate over the file's >= 5.2; each frame rate a logged finding); the pick <= 16 ms; nothing renders under G-scope; no press or held move past a frame; a pull's first move per thousand moves copied |
| `gcode:lines-build` | item 10: `buildLineGeometry`'s typed-array prisms are the old build's, bit for bit |
| `page:manifest` | the page loads each script once |

## Not done here

Neither plate is saved with the session, and a plate has no Undo of its own
(CLEAR is the way to start over). A piece's beads last only until a seat turns
it. A piece dragged INTO a slice stays part of that slice: it is not grabbed
and moved afterwards, as a plate's pieces are.

## 13. Compare plates: side by side, then overlaid, then measured

**What the user sees.** With a file on each plate, the card shows a folded row, *Compare plates*, with four
ways in, each one click or two. **Plates** sets both whole plates down side by side on a **third plate**
(Compare) - nothing to isolate, no region box to drag. **Pieces** asks for a click on a piece on plate 1, then
plate 2 is shown and asks for a click on a piece there; the second click sets both pieces down on plate 3
(press Pieces again to leave the pick). **Circle** is Pieces with a ring: press at the middle of a piece on
plate 1 and drag out - a yellow ring follows the pointer, the card reads its radius - and let go; everything inside its
cylinder is taken, at every height (all layers, every line type that is shown, supports with the piece). Then the same on
plate 2, and both land on plate 3. A segment is in when its midpoint is within the radius; a mesh piece when any triangle
centroid is. A ring that holds nothing is refused and you draw it again; Esc or the button again leaves the pick. **Selected** is the older way: isolate something on each plate - a
piece with its supports, one line type, a layer band: whatever a drag would carry - then press it. On plate 3,
plate 1's is at the left in orange and plate 2's at the right in blue, each at the height it came from, the
camera close on them. Plates 1 and 2 are not touched. **Overlay** moves the blue
one so the two parts' outlines coincide (XY only; the heights stay; with no part walls - supports alone - it
lines up by everything drawn) and draws both see-through. The arrows nudge the blue piece by the step chosen
(0.05 - 5 mm), Z too; the row reads the total. **Colours** puts the line types' own colours back. The
Features list and the layer slider act on both pieces at once. **Clear compare** empties plate 3.

**Measure** (Diff readout). Reads the two pieces' moves, already in one frame, and writes a table: per line
type (part, support tree, interface, transition) the Z range and layer count of each side and the area only
A's, only B's, and both; the *first layer of every plate region* (interface / transition lines joined across
1 mm) with the tree under it, whether there is none (**GAP**), and the tree standing out past the plate's
outline (**overshoot**, area and furthest reach); and the layers that differ most. **Copy JSON** gives the same
as data: `compareReport()`. **Where** (`gaps`): the support-family material only one side has, joined across 1 mm into
pieces of 1 mm2 or more and stacked layer on layer into regions - each with Z from/to, layers, area, centre X Y and
bounding box, in *plate 1's own file coordinates* (the piece's offset on the compare plate is read off `srcAt`, its first
move's place in its file, and taken off): `aLacks` (the reference has it, ours does not - the ones to fix, largest 12)
and `bLacks` (ours has it, the reference does not). "The layer under" is each side's own last layer that carries support (Bambu's
support layers sit at their own Z between the part's), and only if within 0.5 mm below.

**How it is built.** `compareStart` reads each plate's selection with `pullSpec` (the drag's own read) and
sets the two copies down on plate 3 with `makeGhost` / `setDownOn` at a chosen XY and the height they came
from - so a compare is a plate of two pieces, and every piece control (move, seat, Export) works on it. A
piece's `tint` is written into its kept geometry's colours (`tintGeometry`); `alpha` draws it see-through.
`bakePiece` moves the blue piece for Overlay and the nudges. The measuring is `nso-gscope-diff.js`
(`NSOCompareDiff.compute / text`): pure, each move painted at 0.1 mm as the stadium it prints, exact
distances by EDT. State: `NSO_MICROSCOPE.compareState()`; `compareStart / compareOverlay / compareNudge /
compareTint / compareClear / compareDiff / compareReport`.

**Not built (on purpose).** Swapping the reference's layers into our output, or feeding the differences back
to the generator, is not done; the report is the input to either.

**Check.** `compare:diff` (`tools/nso_compare_diff_test.js`, synthetic moves with known answers) and
`gscope:compare` (`tools/nso_gscope_compare_test.js`): refused with nothing isolated; plate 3 holds two
tinted pieces, plates 1 and 2 byte-identical; Overlay's outlines coincide; the nudge moves only the blue
piece; Colours off and on again are exact; Clear compare empties plate 3; the measurement reads. `COMPARE_A` /
`COMPARE_B` name two other `.gcode.3mf` files for it.
