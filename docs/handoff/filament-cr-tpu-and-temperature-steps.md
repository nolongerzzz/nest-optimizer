## Filaments on the Slice card - CR-TPU, the four filament rows, temperature steps by height (2026-11-13)

New: `docs/FILAMENTS.md`. Changed: `app-print.js` (`FILAMENTS`, `filamentBase`, the rows, `plannerExtras`), `nso-print-planner.js` (filament tokens in
`thaw`, `filament_retraction_length`, `tempSteps`, `filamentStart`, `configValue`), `tools/print-planner/freeze.js` + both `frozen.json` (the filament's
numbers in the start block are tokens), `index.html` + `styles.css` (seven rows in `#slice-settings`), `tools/print-slice-check.js` (section 3c).

**What you get.** Supports > Slice > Slice settings has a **filament** row (Profile (PLA), Creality CR-TPU 95A), **temp / first layer / bed / max flow**
(filled with the filament's own values, editable) and **temp step / every** (a temperature tower from any model: temp 240, step -5, every 10 mm). The readout
names the filament and lists the temperature bands as written.

**PLA is unchanged.** An untouched card slices to the same G-code as before on both printers, byte for byte; `freeze.js --check`, `print:planner` (127) and
`print:slice` (91) pass.

**The start block was PLA's.** The frozen blocks held PLA's flush speed, flush temperature, purge-line feeds and `set_filament_type:PLA` as text, so any other
filament would have been purged at PLA's flow. They are tokens now, computed from the config (docs/FILAMENTS.md has the table). The non-PLA side of each
`{if filament_type == "PLA"}` is read off `machine_start_gcode` in the template. For the A1 mini it is now checked against Studio: the owner's own
Generic TPU slice (`fixtures/print-planner/a1mini-0.4/studio-generic-tpu-tower.gcode.3mf`) and NSO's start block with its numbers are the same 472 lines
(`print:slice` 3c). That slice also set the bed (30 C on the A1 mini, Studio's own) and showed the CONFIG_BLOCK keeps `retraction_length = 0.8` while the
G-code retracts the filament's 0.4. The P1S has its own Studio TPU slice beside its frozen block and the same check (269 lines, bed 35).

**Not measured.** CR-TPU's max flow (3.2 is Studio's Generic value), retraction past 0.4 mm, flow ratio, bridge speed at 235 C. The P1S entry has not printed.
The card does not yet step max flow by height (the max-flow test); `tempSteps` is where that would go.

**Also.** The pre-existing 6 px overflow of `#slice-settings` ("support below" is wider than its column) is as it was; the new rows add nothing to it.
