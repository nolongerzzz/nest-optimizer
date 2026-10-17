# G-scope's second plate: LENS and TAKE

`app-microscope.js` ("Two plates"), `app-grab-drop.js` (its world adapter),
`nso-watch.js` (the log's dock). Checked by `gscope:take`
(`tools/nso_gscope_take_test.js`, 1280 x 800).

G-scope had one plate: whatever you loaded. It now has two.

- **LENS** is what you loaded - the plate read, or an imported file. It is the
  only plate anything is loaded *into*. **Nothing on LENS ever changes** by
  anything that happens on TAKE.
- **TAKE** starts empty and holds **copies** you pull off LENS. Pull as many as
  you want; each pull is a copy.

The top-right row is **BACK · LENS|TAKE · CLEAR · EXPORT · CLOSE**. LENS | TAKE
is one two-state toggle. The viewport shows one plate at a time, and the legend,
the readouts, the layer slider and every card follow the plate shown - they
already read "the document", and the document is the shown plate's.

## 1. Pulling

Every isolation G-scope can make is, underneath, one thing - the selection
(`setSelection`): a capture-box region, a picked line, a layer or a layer range
(Select shown), a whole piece, a feature from the legend ("only", a detector
row). So there is one gesture for all of them:

**press on the isolated thing and drag.** The press has to land on the selection
(its highlight, or the isolated detail). Past 3 px (`nsoGrab.SLOP`) the view
flips to TAKE *while you hold*, the copy follows the pointer, and where you let
go it lands; the view stays on TAKE. **Escape** mid-drag cancels the pull, keeps
nothing and returns to LENS. A press that never travels is still a click
(Pick a line, a new capture box...); a press on empty space still orbits; a
capture box's three dots keep their press, and so does its face while
**Click to select region** is armed and the face is in front of the selection (it
scales the footprint). To pull a boxed region, press it in Orbit, or on any
selected thing outside a face.

What lands is what Export would write: a slice's beads as their prisms (the
moves ride along, shifted with the piece, so "as solid" still works) and a
mesh's own triangles. One pull = one piece, named as an export is named.

LENS is not touched - not its document, hidden / cleared sets, selection, boxes,
layer range, mode or camera. `NSO_MICROSCOPE.plateState('lens')` reads all of
that, plus a checksum of every coordinate, and the check compares it before and
after each pull.

## 2. Pieces on TAKE

TAKE is a mesh document (`source: 'take'`) in the Z-up millimetres of a bed
centred on the origin, so the legend (**Parts**), the capture box, the clip
slider, Isolate, Clear from view and the exports read it as they read any mesh.
The detector rows (flange, handle ...) and Slice are LENS's: TAKE holds copies.

Pieces are grabbable and droppable **as on the main plate** - this is
`app-grab-drop.js`, not a copy of it. Its state machine takes a *world*
(`nsoGrab.begin(piece, idx, ev, world)`): how the pointer becomes a ray, what is
under it, where a pose is read and put back, and what the three drops do. The
default world is the main plate, unchanged (`grab:drop`, 34 gates); TAKE hands
its own, and a pull is a grab of a piece that does not exist yet.

| let go over | it lands |
|---|---|
| **a piece** | seated onto it at the point under the pointer, outside the surface, at the **Seat gap** - `NSO_SeatSurface.plan`, the same plan and gap rule as Seat here and a main-plate drop. If the plan has to turn the piece the turn is baked into its triangles and it stops being a slice's beads (no "as solid"). Refused in words when the pose would be below the bed. |
| **the bed** | on the bed at that point: lowest point z = 0. |
| **nothing** | where it was let go, in the air, still grabbable. |

Escape puts a carried piece back exactly. TAKE has no Undo of its own; CLEAR is
the way to start over. A drop selects the piece.

## 3. Export acts on the plate shown

- **LENS**: today's selection exports, unchanged (Selection, and Sliced piece
  while a slice made here is shown).
- **TAKE**: **Whole plate** -> main plate (each piece its own object, **one**
  Undo, G-scope closes as after any export) / as STL (one file, the pieces where
  they stand); **Selected piece** (the Selection group, retitled) -> main plate /
  as STL, as lines or as solid, as today.

## 4. CLEAR, opening, exits

- **CLEAR** empties TAKE. **Shift-CLEAR** also drops the imported file on LENS
  and reads the plate again into it (LENS is then shown).
- Opening G-scope from the main plate opens on **LENS**: it re-reads the plate;
  an imported file stays until CLEAR (shift). TAKE keeps its pieces across
  close / reopen and across every load.
- **BACK and CLOSE are the only exits** (Escape still shuts an open card, then
  closes G-scope, as before). **A double-click on the view does nothing** - it
  used to step back to orbit and then close.

## 5. Watch's log

Docked bottom-right, under the slider's All button (see docs/WATCH.md). The
slider ends above it and the bottom readouts stop short of it.

## 6. Not done here

TAKE is not saved with the session and has no Undo. Overhangs and Slice read
LENS only. A slice's pieces keep their beads only until a seat turns them.
