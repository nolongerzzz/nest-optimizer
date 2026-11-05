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
- **Gate:** `npm run print:slice` (~37 s, weight 64000): the coupon with NSO's trees on the
  A1 mini (FEATURE lines carry Support / Support interface / Support transition, the packager's
  checks), the refusals, the profile mapping and file names, and the coupon alone on the P1S so
  the P1S template path stays covered. No browser step in `testSteps`; the drive is the audit
  driver's.
- **One-off, not in the gate:** the Simple Overhang arc with one NSO tree on the P1S (256 mm
  bed, centred), run once through `NSO_Print.build` with the P1S template and blocks: ok,
  2 objects, 244 layers, 2369 s, 6.65 g, 601,860 bytes; features Outer / Inner / Overhang wall,
  Sparse / Internal solid infill, Top / Bottom surface, Bridge, Support, Support interface,
  Support transition; `printer_model_id` C12 in `slice_info.config`. ~36 s (24 s building the
  tree, 12 s the build).
- **Needs ticket A** (`claude/print-packager-one-object`, not on `claude-wip` yet): a
  one-object plate packages today with an empty `plate_1.json` footprint.
- **Owner check:** open the downloaded file in Studio's preview - supports show as
  support. Then print a small watched coupon: the first layer, the first retraction and
  z-hop, the end lift.
