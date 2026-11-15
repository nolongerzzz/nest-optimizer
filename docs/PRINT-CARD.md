# The Print card: one place for the printer, the slice and the supports

`index.html` `#menu-supports` (the column's **Print** drop-down), `app-supports-card.js` (the card), `app-print.js` (the slice and its settings),
`app-gscope-slice.js` (G-scope's view). 2026-11-14.

The owner: *"The supports card already is the print/prep card, just currently titled supports. It needs to become the only card that handles all
slice, printer, supports settings, so all levers live in one place. G-scope is for strictly preview and inspection of whatever goes in."*

Before this the slice settings lived in three places: the Supports card's Slice section, its Advanced rows, and G-scope's own Slice settings box.
There is one now. The card kept its file and its ids (`sup-*`, `slice-set-*`), so everything that drove the Supports card drives this one.

## 1. What is on it

| | |
|---|---|
| Saved settings | the row at the top: every lever of the card under a name (section 5) |
| Printer | `#print-printer`: the Plate panel's choice (`#plate-select`), shown here too. Either one changes the plate; the other follows |
| **Slice** | `#btn-sup-all`: the one button that makes the plate's slice (section 2) |
| **Preview** | `#btn-sup-slice`: opens that slice in G-scope |
| **Export** | `#btn-slice-export`: saves it as `.gcode.3mf` |
| Printer and filament | nozzle, filament, temperatures, max flow, flow ratio, retraction length and speed, z-hop, temperature steps |
| Quality | layer height, bridge speed, bridge flow, bridge temp |
| Strength | walls, infill density and pattern |
| Supports | the **Supports** tick (`#sup-on`), then Auto / Assisted / Custom, Paint, Supports Blocker, Angle, Type, Size, May rest on the part, Exclude small overhangs, Interface angle, Tree settings, Advanced (Bambu's 17 rows), Tree planner |
| Adhesion | Brim, Raft layers, Raft contact - outside the part the tick greys, so a raft is set with or without supports |

Slice, Preview and Export are the only buttons. Gone: Generate, None, Remove, the Slice section's own Slice button, the second support angle,
the interface-rule row, "Platform under flat faces" (the owner does not use it), and G-scope's settings box.

## 2. Slice

`printSlice()` in `app-supports-card.js`.

- **Supports ticked:** builds the plate's supports, then slices. One piece on the plate is built as the card's piece; two or more as the plate
  build. If nothing changed since the last build (`printSig()`: the angle, the mode, the type, every tree number, the blockers and paint, the
  pieces and where they stand) the supports on the plate are kept and only the slice is made again. **To regenerate supports: change a setting
  and press Slice.** A plate with nothing that hangs is sliced as it is.
- **Supports unticked:** the plate's supports are taken off (`plateTakeOff()`, one Undo puts them back) and the bare plate is sliced. The tick
  is what "None" was: it is not a type.
- The slice is the plate's one slice (docs/GSCOPE.md): Preview and Export use it, and G-scope shows it.

## 3. Types

`#sup-style`: **Straight strut**, **Tree**, **Gecko Hands**. They are what a support is made as; whether there are supports at all is the tick.

**One planner for the tree** (`flowFed()`, `nso_support_gridpack.js` `planFlow(rawTris, opts, F)`): Assisted and Custom grow the Tree type with
the flow tree Auto uses (docs/SUPPORT-FLOW.md), so every mode gets the same branches, the same merging and the same landing rules.

- Assisted: the detector's spots, less the ones turned off, thinned to tips as Auto's are.
- Custom: the tips given are every tip, each stood as given (no thinning, no twigs, no spots added).
- The flow tree lands where its reach field lets it and has no members to erase, so under the Tree type the landing circles, the eraser and
  Tune are not shown. Straight strut and Gecko Hands keep them (they are the lattice planner's).
- A piece is turned off, whole or in part, with a Supports Blocker (or by clicking an area out in Auto): there are no per-piece settings.

## 4. One angle, one interface rule

- The card's **Angle** is the slicer's support threshold too (`readSettings`: `sup-angle`). The second angle row is gone. An oblique face that
  is not picked up at 30 needs the angle raised (the owner's Supporttest was sliced at 46), and the slicer now follows.
- The interface is the slicer's **column** rule, always (`interfaceRule()` / `ifaceRule()` return `'column'` when the Print card is on the page).

## 5. Starting values, per plate, saved settings

- **Every row starts at the printer profile's value** (`settingsFromConfig`): for the A1 mini that is top Z 0.2, first layer 90 %, max bridge
  length 0 (every bridge supported), angle 30. A slice with no settings at all (a test; G-scope looking at a loose STL) is given the same.
- The numbers NSO used before are the built-in saved setting **NSO classic** (top Z 0.18, first layer solid, bridges to 5 mm). It sets only
  those three rows, and cannot be deleted or saved over.
- **Per plate:** each plate keeps its own card (`BEDSET`, keyed by the bed's id; `bedSync()` on every tick). Switching plates puts that plate's
  levers back. The printer itself is one for all plates (the app has one `state.plate`).
- **Saved settings** (docs/SUPPORTS-CARD.md 10) keep the whole card now: the Supports tick, the slice rows, the filament. Not the printer or
  its nozzle - a saved setting goes with any printer.
- Brim is one row (`slice-set-brim`): auto, outer, none. The supports' own brim tick is gone; with auto a tall supported part gets its ring.

## 6. G-scope is a view

G-scope's Normal / Slice switch shows a slice; it sets none. There is no settings box, only a note saying whose slice is on screen:

- the plate -> the Print card's slice, made with the card's settings;
- anything else opened there (an STL, a 3MF) -> sliced at the printer profile's values, to be looked at;
- a `.gcode.3mf` -> the file as it was sliced.

Every inspection tool (regions, gap ruler, bands, features, measure, play) works on all three.

## 7. Held by

- `npm run print:slice` (109): the card's markup - the three buttons, the sections, the types, nothing left of the old cards, no G-scope rows;
  the profile's starting values; a slice with no settings equals the untouched card's.
- `npm run support:advanced` (28): each row from the profile, changed, to the slicer and to Bambu's key.
- `npm run print:card` (11, headless): Slice builds, builds nothing when nothing changed, builds again after a change; Assisted and Custom
  on the flow tree; strut still the lattice; the tick off takes the supports away.
- `npm run support:settings`, `npm run support:settings-drive` (the real page: Slice ticked and unticked, Undo, NSO classic, Preview, the Printer row).
- The support gates (`support:gate`, `support:gate-rest`) slice at the engine's own 0.18 / solid first layer; `--profile` runs them at the
  profile's 0.2 / 90 %.

## 8. Known edges

- The A1 and the other printers without a slice profile can be picked on the card; Slice then says which printers it can slice for.
- With Supports unticked the supports leave the plate (Undo brings them back); they are not hidden and kept.
- The Assisted and Custom tools work on one piece's points (pick the piece to place them); Slice builds every piece on the plate, each with
  its own spots, tips and blockers.

## The export's name, and Save as (2026-11-14)

An export is named after the file its pieces were opened from, then the printer: `String_test - A1 mini.gcode.3mf`.
A 3MF's objects carry whatever its designer called them (the owner's string test came out as
"IngeniousLeelo-Habbi"), so a model keeps `sourceFile` (`app-core.js` `import3MF`), the Print card's pieces
carry it as `file`, and `fileName` (`app-print.js`) uses it before the piece's own name. Pieces of one file
share its name; of several files they are counted ("3 pieces").

**Save as...** under Export saves the same file under a name its owner picks (`saveAs`, `gcodeName`). Chrome and
Edge open the system's save dialog (`showSaveFilePicker`), so the folder is picked too; Safari and Firefox have
no such dialog for a page, so the name is asked for and the file goes to Downloads under it. Checked in
`print:slice` (the names) and by hand in the page (the buttons).

