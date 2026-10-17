# G-scope's SELECT card: one selection model, five ways in

`app-microscope.js` ("The Select card", "The Features list", "The gesture"),
`index.html` (the Select card, the slider's Range card), `nso-watch.js` (what it
logs). Checked by `gscope:select` (`tools/nso_gscope_select_test.js`, 1280 x 800),
on top of ticket 1's LENS | TAKE plates (`docs/GSCOPE-TAKE.md`).

## 1. The modes

A row of five in the Select card: **Piece · Region · Feature · Line · Layer**.
They replace Orbit / Click to select region / Pick a line / Select layer, and the
Line and Layer cards folded into Select (Render and View are unchanged). A
document opens in Piece.

| mode | a click takes | where |
|---|---|---|
| **Piece** | a whole piece (a slice: every move of one object; a mesh: the object) | any |
| **Region** | the capture box - click a piece to drop one, size it by its dots as before | any |
| **Feature** | a slicer line type: a line of it on the piece, or its row in the Features list | a slice |
| **Line** | one extrusion line; ◀ ▶ (and the arrow keys) step along it as before | a slice |
| **Layer** | every layer is a card; hover highlights it, click isolates it, drag pulls it. The slider's range is one card more (the **Range** grip beside the slider) | a slice |

Feature, Line and Layer are a slice's; on a plate piece or on TAKE their buttons
are disabled. There is **no orbit mode**: a press on bare plate - nothing to take -
orbits, in every mode. (A press on a piece, a line or the selection is the
gesture below, so to orbit, press the bare plate beside it.)

## 2. In every mode, the same three things

- **Hover** outlines what a click would take (a cyan outline over the view; in
  Region, the box a click would drop as a wire). The cursor is a pointer.
- **Click** isolates it: the selection alone is drawn, the rest is out of the view
  (what Isolate has always done). **Click it again, or press Escape, and it is
  whole again** - the selection stays, so a click on it isolates it once more.
  Escape's order: an open card first, then what is isolated, then G-scope.
- **Drag** pulls it onto TAKE - ticket 1's gesture, from the hovered thing
  itself, with no click first. LENS is byte-identical afterwards. On TAKE a drag
  on a piece moves it, as before.

A box's three dots keep their press; so does its face while Region is armed and the
face is in front of what is drawn there (it scales the footprint). A click on the
box with no travel toggles the isolation of what it holds.

What a press takes is decided once, at the press (`pressTarget`): the selection when
it is under the pointer, else what the mode takes there (`targetAt`). What follows
decides the rest - travel past 3 px is a pull, a release in place is a click.

### The range card

The slider's two handles narrow what is drawn; the **Range** grip is that range as
one card: hover outlines everything drawn, click isolates it, drag it onto TAKE
and it lands as one piece. (The handles and the bar still move the range.)

## 3. The Features list

The legend is now the **FEATURES** list: the slicer's line types only,
Bambu-style - a colour swatch, the name, a count, and a **Display** check. The
check hides or shows that type in the view **on both plates** (`FEATURE_OFF` is one
set: unchecked on LENS it is unchecked on TAKE, and it survives LENS being read
again; a new slice opens with Travel off, as before). On TAKE a piece that is still
a slice's beads is drawn bead by bead in its line types' colours, minus the types
switched off, and the list counts the types on TAKE. Clicking a row anywhere but its
check is the Feature click (that type, isolated; again, whole); dragging a row pulls
it; hovering a row outlines it. The old per-row "only" button is gone - its
click does it.

A part that is not sliced has no line types; the list says "Not sliced - no line
types." Plate pieces are chosen in Piece mode, and hidden with View > Clear from
view.

## 4. What left G-scope

Surface features - the Flange row, Handle / Bracket / Lid / Hinge - and Lift's
**Features** readout (`app-gscope-lift.js`, `#ms-lift-row`) are gone from G-scope.
They live on the plate (Subtract > Lift, `docs/LIFT.md` section 7). The detectors
(`nso_flange.js`, `nso_face_features.js`) and their unit checks stay; only G-scope's
use of them went, and with it `gcode:gscope-flange` and `gcode:gscope-features`.

## 5. Ids

Stay, on the new controls: `ms-mode-select` (Region), `ms-mode-line`,
`ms-btn-isolate`, `ms-btn-isolate-line`, `ms-btn-clear`, `ms-btn-back`,
`ms-line-prev` / `-next` / `-read`, `ms-layer-prev` / `-index` / `-next` /
`-select`, `ms-layer-note`, `ms-select-controls`, `ms-line-controls`,
`ms-layer-row`. They live in the Select card; the Line and Layer rows show
whenever a slice is open (pressing one switches the mode).

New: `ms-mode-piece`, `ms-mode-feature`, `ms-mode-layer`, `ms-mode-row`,
`ms-mode-note`, `ms-zr-card`. Gone: `ms-mode-orbit`, `ms-nav-line`, `ms-nav-layer`,
`ms-card-line`, `ms-card-layer`, `ms-detected`, `ms-lift-*`, `.ms-legend-only`.

`NSO_MICROSCOPE.setMode` still takes the old names (`'orbit'` is Piece, `'select'`
is Region); `mode()` returns `piece | select | feature | line | layer`.
New readers: `hoverInfo()`, `isIsolated()`, `pressTargetAt(x, y)`.
