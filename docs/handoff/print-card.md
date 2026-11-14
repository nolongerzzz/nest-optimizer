## The Print card: the Supports card became the one card for printer, slice and supports (2026-11-14)
Branch `claude-wip`. Card: `index.html` `#menu-supports` (summary "Print"), `app-supports-card.js` (`printCard`, `printSlice`, `plateTakeOff`, `printSig`,
`printSync`, `BEDSET` / `bedSync`, `flowFed`, `PRESET_BUILTIN`), `styles.css` (`.print-card`). Settings: `app-print.js` (`settingsFromConfig` reads the
profile's support keys; `slicerOptions` gives a settings-less slice the same). G-scope: `app-gscope-slice.js` (no settings box; a note). Planner:
`nso_support_gridpack.js` `planFlow(rawTris, opts, F)`. Doc: `docs/PRINT-CARD.md`.

- **The owner's ask:** the Supports card "needs to become the only card that handles all slice, printer, supports settings"; G-scope "strictly preview
  and inspection". Then the decisions: types are Straight strut / Tree / Gecko Hands; None is a **Supports** tick; main button **Slice**, with Preview
  and Export the only others; raft reachable with the tick off; one angle; starting values the profile's; interface always column; Assisted and Custom
  on the new planner; no "platform under flat faces"; printer choice on the card; per plate; per-piece overrides are the Supports Blocker.
- **Slice** builds supports (when ticked and something they are built by changed) and slices; unticked it takes the plate's supports off (one Undo) and
  slices bare. To regenerate: change a setting, press Slice.
- **Starting values are the profile's now:** top Z 0.2, first layer 90 %, max bridge 0 (were 0.18, 100 %, 5 mm). The old numbers are the built-in saved
  setting **NSO classic**. A slice with no settings is given the profile's too, so the untouched card and a bare `build()` make the same file.
- **Assisted and Custom, Tree type:** the flow tree, from the user's spots (thinned) or tips (as given). No landing circles, eraser or Tune there - the
  flow tree has no members and lands by its reach field. Strut and Gecko Hands still use the lattice planner and keep those tools.
- **Per plate:** each plate keeps its own levers (`BEDSET`). The printer is one for all plates (`state.plate` is one): not split.
- **G-scope** has no slice rows. Plate -> the card's slice; a loose STL / 3MF -> the profile's values; a `.gcode.3mf` -> as sliced.
- **Tests moved with it:** `print:slice` (109: the card's markup, profile starts, gate parity at the engine's two numbers), `support:advanced` (28),
  `support:settings-drive` (the real page: Slice ticked / unticked, Undo, NSO classic, Preview, Printer row). `support:gate --profile` runs the gate at
  the profile's 0.2 / 90 %; the gates themselves still slice at the engine's 0.18 / solid.
- **Not done / to watch:** printers without a slice profile (A1, Prusa, Ender, custom) can be picked and then cannot be sliced - the card says so.
  Supports are removed, not hidden, when the tick is off. `docs/SUPPORTS-CARD.md` still describes the old three-state Generate card in places.
