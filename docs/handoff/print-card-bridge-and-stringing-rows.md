## Print card - bridge speed and flow, flow ratio, retraction length and speed, z-hop (2026-11-14)

Changed: `index.html` (two rows in Quality, four in Printer and filament, `#slice-bridge-note`), `app-print.js` (the six settings, `tuneWords`,
`bridgeSpeedOf`, `bridgeNote`), `nso-print-planner.js` (`settingsFrom` reads the filament's own retraction speed, z-hop, wipe and minimum travel),
`app-supports-card.js` (`PRESET_FIELDS`: saved settings keep the six), `tools/print-slice-check.js` (3c, 11 checks), `docs/FILAMENTS.md` ("Bridges and stringing").

**What you get.** Quality: **Bridge speed**, **Bridge flow**. Printer and filament: **Flow ratio**, **Retraction length**, **Retraction speed**, **Z hop**
(filled with the filament's own; empty is the filament's own). A note under the bridge rows says when the filament's max flow, not the row, is what sets the
bridge speed (CR-TPU: 25.5 mm/s whatever is set above that). The readout gives the numbers as printed.

**Unchanged.** A card with nothing touched slices to the same G-code as before on both printers. `print:slice` (120), `print:planner` (127), `freeze --check`.

**Why the filament's keys.** Studio's own TPU slice keeps `retraction_length = 0.8` in the file and retracts the filament's 0.4, so the rows write
`filament_retraction_length` / `_speed` / `filament_z_hop` and leave the printer's keys alone.

**Bridge temp (same day, after the first print).** Bridge speed 12 made the bridges worse (curls), and Studio's own tower bridges exactly as NSO does
untouched, so the lever is temperature. **Bridge temp** (Quality, empty: off) prints a layer's bridges at their own nozzle temperature, changed at the printer's
park: retract, lift, the A1 mini's purge position, `M109`, prime, wipe, back - once in before the layer's first bridge and once out after its last
(`parkAt`, `PARK`, docs/FILAMENTS.md "Bridge temperature"). A1 mini only: the P1S is refused in words until its park moves are written. `print:slice` is 131.

**Not built.** The P1S's park, avoid-crossing-walls travel, wipe distance. None has been printed yet: the rows are checked in the
G-code (feeds, strand width, retraction, lifts), not on a part.
