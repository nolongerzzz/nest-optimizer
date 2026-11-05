# Supports Blockers, and Slice and Preview

`nso_support_blockers.js` (pure), `app-support-blockers.js` (the boxes in the view), and the Supports card
(`app-supports-card.js`, [SUPPORTS-CARD.md](SUPPORTS-CARD.md)). Checks: `npm run support:blockers` (Node) and
`npm run support:blockers-drive` (Chromium, real clicks and drags).

## What it is

A **Supports Blocker** is a ghost box on the plate. No support is made inside it. There can be as many as you like,
anywhere; boxes that overlap (or touch on a face) are one larger area, whatever shape they make together.

**Adding one**

- the card's **SUPPORTS BLOCKER** button (under the Paint row): a box round the middle of the selected piece, a third
  of its size (10 - 40 mm); with no piece, 20 mm, standing on the middle of the plate;
- the right-click menu's **Add Supports Blocker...** (under Mirror across X): opens the Supports card and puts a box
  where the click was - centred on the point of the piece under the pointer, else standing on the bare plate there.

The new box is picked.

**Editing one** (while the Supports card is open; the boxes are drawn only then and are there when it is opened again)

| do | what happens |
|---|---|
| press on a box and drag | moves it across the plate, its height kept |
| the same with **Shift** | moves it up and down |
| drag the **handle on a face** (the picked box shows six: a rail and a dart on each face) | moves that face; the opposite one stays; never under 1 mm each way |
| **Escape** during a drag | puts the box back where the press found it, no Undo step |
| **Delete** (the key, with a box picked), or the card's **Delete** | takes the picked box away - and not the piece |
| the card's **Clear** | takes every box off the plate |
| a click on nothing | puts the pick away |

Every add, move, stretch, delete and clear is **one Undo** (a move is one however long the drag was). Undo of a Delete
picks the box it brings back. A press that lands on a piece standing in front of a box that is not the picked one is the
piece's, so the card's clicks on a piece still work; the *picked* box is grabbed through the piece it is round (a box put
round a piece is, mostly, behind its skin). The card's brush, circles and eraser keep the pointer while they are on.

While a drag runs the box is a **draft**: the card is told when the pointer is let go, not on every pixel, so the
planner's detection and the footprint it re-traces are not redone sixty times a second.

The readout under the button says what the boxes make: `2 blockers - 1 area - picked 20 x 20 x 20 mm at x 4, y 0, z 10`.

## What a blocker stops

Three things, all read from the same list of boxes (`NSO_SupportBlockers`, nso_support_blockers.js):

1. **The spots.** A spot (a beacon: the place a support would touch the piece) inside a box is not planned, outlined or
   counted. The card says `1 hanging area at 35 deg on bridge - 40 spots blocked`; the area keeps the rest. A box that
   holds every spot leaves the state "nothing": *Every spot is inside a Supports Blocker*, GENERATE off, a build adds
   nothing. In Assisted and Custom the same spots are not shown and a tip placed in a box is not built.
2. **The surface they held.** An area's footprint - the outline the card draws, and the contact surface the interface
   sheet is laid over (the raft: docs/SUPPORT-FOOTPRINT.md) - has the blocked part cut away, so the sheet does not fill,
   under the part, what the box was put there to keep free. The footprint is traced again on a 0.25 mm raster, with
   every cell whose *surface* lies in a box taken out. A cell's surface height is read off the plane of the nearest
   spot (`z - (nx dx + ny dy) / nz`), so a box over the high end of a ramp holds only the part of the surface that is
   inside it, not the whole column. A footprint no box reaches is left alone (the same object: nothing is re-traced), and
   so is one whose surface lies above or below the box.
3. **The supports themselves.** Each box is handed to the planner as an obstacle, as another piece is
   (`opts.occluders`, and the feet's `shareFeet`), so a trunk or a sheet is routed round it and none stands in it. A
   spot the planner then cannot reach is reported unreachable, as ever.

A plate with no box builds **exactly the bytes it built before**: nothing is passed, re-traced or filtered
(`support:blockers` gate C, and `support:plate`'s pins).

Detection (`NSO_SupportAim.detectOverhangs`) does not know about boxes - its cache stays valid as they move - and neither
does G-scope's own support row: this is the Supports card's. The boxes are not pieces: Slice, Export and the 3MF never
see them.

## Beds, Clear plate, Undo

`state.supportBlockers` (an array of `{ id, c: [x, y, z], h: [hx, hy, hz] }` - centre and half sizes in the plate's
frame, mm, Z up) belongs to the **active bed**: `app-beds.js` swaps it with the bed's pieces (`stash` / `load`). **Clear
plate** and **Delete plate** wipe the bed's boxes with its pieces (no Undo, as Clear plate has none). Undo is the bed's
own line, like every other card edit (a `supportSwap` step with an `onUndone`).

## Generate for plate

The boxes apply to every piece: each piece's own spots are filtered, its footprints cut and the boxes handed to the
planner. The plate's readout adds `- N spots blocked`; a piece all of whose spots are in a box is reported
*every spot is in a blocker* in its row.

## Slice and Preview

The card's last button. It is the **Slice card's own slice** of the plate (every piece, supports included, for the
plate's printer: `NSO_Print.card.slice`, app-print.js) and then **the Slice card's own Preview in G-scope**
(`previewInGscope`) - `NSO_Print.card.sliceAndPreview`. Nothing is added to the plate, and the Slice card is as it
was: its four controls, and its readout and Export hold this slice afterwards, exactly as if its Slice had been pressed.

- While it runs: the button says *Slicing...* and is off, **Cancel** shows, and the line under it is the Slice card's
  own stage line, word for word (*Slicing 2 objects - 14 s*). GENERATE is off meanwhile (a slice reads the plate; it is
  not changed under it).
- Done: G-scope opens on the Slice side with the slice loaded, and the Supports card is put away.
- Refused or failed: the Slice card's words, in red, under the button, and the card stays open (*Nothing on the plate to
  slice.*, *Pick the A1 mini or the A1 / P1S / X1C plate to slice for.*, the planner's refusal ...). Cancelled: *Slice
  cancelled.*, not in red. A plate that moved while it was slicing is not opened: *The plate changed while it was
  slicing. Press Slice and Preview again.*
- **G-scope's Export card is live on the slice.** A slice opened by Slice and Preview (or the Slice card's Preview) carries
  the record it was made from on its document (`doc.nsoPlateSlice`: the file's bytes, a snapshot of the pieces and the
  gcode's `OBJECT_ID` of each). The EXPORT button no longer greys out, and the card gains two groups:

  | group | button | what it downloads |
  |---|---|---|
  | **This slice - whole plate** | Export .gcode.3mf | the slice as it was made, the file G-scope shows |
  | | Export .3mf | every piece and support on the plate as a Bambu Studio project (the Export card's 3MF writer and cooling profile; each support keeps its own slicer overrides) |
  | **This slice - selected** (shows only with a selection) | Selected .gcode.3mf | the selected pieces **sliced again, alone**, with the supports that hold them - same profile, same engine, so its layers are the plate's own |
  | | Selected .3mf | the selected pieces, with the supports that hold them, as a Bambu Studio project |

  A selection (a capture box, a picked line, an isolated piece) is mapped to pieces through the `OBJECT_ID` of its moves
  (`NSO_MICROSCOPE.selectedObjectIds()`, `NSO_Print.card.indicesFor`). The export is of the slice *shown*, not of the plate
  as it is now: the snapshot rides with the document. The rest of the Export card (to plate, STL, solid, whole plate STL)
  is as it was; `app-print.js` calls only `getDoc`, `selectedObjectIds` and `refreshExport` of G-scope besides its two
  old calls (`print:slice` holds the list).
- `slice()` returns a promise now (`{ ok, reason, cancelled }`), which the Slice card's button ignores; `hook.onStage` /
  `hook.onDone` are how another card hears it. That is the whole of the change to app-print.js.

## Files

| file | |
|---|---|
| `nso_support_blockers.js` | boxes, `blocked`, `areas`, `filterBeacons`, `soupOf`, `clipFootprint`, `footprintsOf` - no DOM; loads in the page and in Node |
| `app-support-blockers.js` | the boxes in the view, the handles, the drag, the Undo steps, the button, `NSO_SUPPORT_BLOCKERS` for checks. Loaded **before** the card and listens for the press first |
| `app-supports-card.js` | `effective()` (spots, footprints), `planArea` / `shareFeet` (obstacles), `runPiece` (the sheet's footprints), the readout, `pointerTool()`, Slice and Preview |
| `app-core.js` | the menu item, where the click was (`state.ctxClick`), Clear plate |
| `app-beds.js` | the boxes ride with the bed |
| `app-print.js` | `slice()` returns a promise; `sliceAndPreview`; `exportSlice` (G-scope's Export card rows for a slice made here) |
| `app-microscope.js` / `index.html` | the Export card's two groups, `selectedObjectIds`, `refreshExport` |

## Known edges

- The footprint cut is exact against a flat surface and to the surface's height read from the nearest spot on a slope or
  a dome (a 3 mm grid): a box edge crossing a steep slope can be off by up to a pitch there.
- A box put round the foot of a piece (on the plate) also keeps the support feet out of it: such a support is
  unreachable, not moved.
- There are no fields to type a size into: the boxes are placed and sized by dragging.
- A box hidden entirely inside a piece, with another box or nothing picked, cannot be picked by a press (the piece is in
  front); pick it by pressing where it shows, or Clear.
