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

**The first print with Bridge temp, and what the file said (same day).** It changed temperature six times on one tower level and the bridges still hung in
loops. The file showed why: NSO laid the level's roof bridge at 45 degrees (lines 8 - 11 mm, both ends in the air) where Studio lays it pillar to pillar
(31 mm). Two fixes: `nso_slicer.js` `freeBridgeAngle` lays a bridge over open air across its gap (docs/SLICER.md "A free bridge's direction"; three pinned
slices re-pinned in `slicer:test`), and the bridge temperature is held for a whole stretch - the bridge layer and the layer over it, walls and fill too - with
one change in and one out at layer changes, counting only bridges over open air (`path.free`). The tower level: two changes, not six. `print:slice` is 134.

**The second print, and the same layer in both files.** Most of the bridge drew tight; the first perimeter over the gap hung low and the bridge drooped as a
bundle. Side by side on the roof's layer: NSO's walls over the gap at 10 mm/s in 0.2 mm moves, Studio's each one move at the bridge's speed; NSO's bridge a
0.4 mm round strand at 25.5 mm/s, Studio's a line of the layer's height at 41.6. Now: `nso_slicer.js` `spanPieces` marks a hanging wall a line width or more
from the layer below (`path.span`) and the planner prints it as a bridge; the planner's `beadOf` lays a bridge over open air at the layer's height
(`thick_bridges`) and keeps the round strand for one over sparse infill (`thick_internal_bridges`). This changes PLA too: Studio's PLA coupon slice tops its
Overhang wall at `bridge_speed` and writes its bridges 0.2 high. `slicer:test` re-pinned (hinge_knuckle_box, top_clip_x2, top_clip_x2_coupon), `print:planner`
3 checks reworded to the measured behaviour, `print:slice` 136.

**The filament holds its dials (the owner: lock TPU in the filament, so nothing outside it moves).** `FILAMENTS[id].tune(config)` is the filament's own
Bridge speed / flow / temp; those rows are filament rows now (empty: the filament's own; Bridge temp 0: none). CR-TPU brings Bridge temp 215 on the A1 mini
and none on the P1S, so it still slices there. `print:slice` is 138.

**Not built.** The P1S's park, a cleaner restart after the park (the owner: the wipe leaves a string, clipped off), avoid-crossing-walls travel, wipe distance. None has been printed yet: the rows are checked in the
G-code (feeds, strand width, retraction, lifts), not on a part.
