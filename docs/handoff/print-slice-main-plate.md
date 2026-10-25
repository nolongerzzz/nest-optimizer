## Slice card: the plate sliced for its printer (print-slice-main-plate)
A SLICE button in the left bar opens a card that slices every piece on the plate,
supports included, with the shared engine and `nso-print-planner.js`, for the plate's
printer profile (A1 mini; the A1 / P1S / X1C plate takes the P1S), and reads out
layers, time and filament grams. **Export .gcode.3mf** downloads the packaged file;
**Preview in G-scope** opens that same file through G-scope's existing `.gcode.3mf`
import, read-only. A plate the planner refuses shows the planner's reason. UI only,
download only: no settings, no Send. Write-up: `docs/PRINT-PLANNER.md`, "The Slice card".

- **Left bar:** Slice, G-scope, Check & repair, top to bottom. The G-SCOPE button moved
  down from the top of the column - same id, handler, label, behaviour; nothing else in
  G-scope changed. `shell:v3` and `ui:shell` were updated for the new positions.
- **New file:** `app-print.js` (the pure half also loads in the slice worker and in Node).
  `index.html` now loads `nso-print-planner.js` and `nso-gcode3mf-write.js` (no G-scope
  file uses them).
- **Gate:** `npm run print:slice`. No browser step in `testSteps`; the drive is the audit
  driver's.
- **Needs ticket A** (`claude/print-packager-one-object`, not on `claude-wip` yet): a
  one-object plate packages today with an empty `plate_1.json` footprint.
- **Owner check:** open the downloaded file in Studio's preview - supports show as
  support. Then print a small watched coupon: the first layer, the first retraction and
  z-hop, the end lift.
