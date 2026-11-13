# Filaments: printing something other than the template's PLA

The printer templates (`fixtures/bambu-templates/<printer>`) are PLA projects, and until this the
plate could only be sliced as PLA: 220 C, and a volumetric limit of 12 mm^3/s (A1 mini) or 21 (P1S).
The Slice card now has a filament and the numbers a filament is tuned by.

## The rows (Supports > Slice > Slice settings)

| Row | What it sets | Empty means |
| --- | --- | --- |
| **filament** | which filament: `Profile (PLA)` or one of `FILAMENTS` in `app-print.js` | - |
| **temp** | `nozzle_temperature` (every layer after the first) | the filament's own |
| **first layer** | `nozzle_temperature_initial_layer` | the filament's own |
| **bed** | the plate type's bed temperature, both layers | the filament's own |
| **max flow** | `filament_max_volumetric_speed`, mm^3/s: every speed is held under it | the filament's own |
| **temp step** / **every** | change the nozzle temperature by this much at every band of height | 0: off |

Picking a filament fills the four number rows with that filament's values; they stay editable.
`Profile values` puts everything back to the printer profile, the filament included. An untouched
card slices exactly as before: the same G-code, byte for byte (`print:slice` holds that).

## What a filament is (`FILAMENTS` in `app-print.js`)

- **keys**: its Bambu Studio filament keys, written over the template's on every filament slot, so
  the planner, the G-code's CONFIG_BLOCK, `project_settings.config` and `slice_info.config` all
  hold them (the last is what tells the printer what is loaded: `type="TPU"`).
- **cooling**: what it changes of NSO's cooling keys (fans, layer-time slowdown).
- **start**: its own filament start G-code, in place of the PLA filament's.
- **studioId**: the Studio preset the file names for that printer.

### Creality CR-TPU (95A)

No RFID, no Studio preset, and too soft for the AMS and the AMS lite: **external spool only**.
The keys are Bambu Studio's Generic TPU (`fdm_filament_tpu` > `Generic TPU @base`):
3.2 mm^3/s, 0.4 mm retraction, flow ratio 1, fan 100 %, printable 200 - 250 C. On top of them, the
owner's A1 mini temperature tower (2026-11-13, dried spool, 240 down to 210 C):

- **235 C** nozzle. 240 and 235 gave the cleanest walls and the least stringing; 210 - 215 bridged
  best. The spool's own range is 210 - 240 C, so 235 keeps a little margin.
- The bed is Studio's own for the printer, which is what that tower printed on: **30 C** on the
  A1 mini (`Generic TPU @BBL A1M`), **35 C** on the P1S (`Generic TPU`).

Not yet measured for this spool: the real max flow (3.2 is Studio's conservative Generic value),
retraction beyond 0.4 mm, the flow ratio, and bridges at 235 C (they sag; slower bridges is the
first lever). The P1S entry is the same keys with its own bed and has not been printed.

When sending: untick the AMS, and turn off flow dynamics calibration (Bambu's advice for TPU).

## The start block follows the filament

The frozen start block (`fixtures/print-planner/<printer>/frozen.json`) was Studio's expansion of
`machine_start_gcode` for PLA, with PLA's numbers in it as text. A 3.2 mm^3/s TPU sent through it
would have been purged at PLA's 12 - 15 mm^3/s before the first layer. What the template computes
from the filament is now a token (`tools/print-planner/freeze.js` has the list and each rule):

| Token | Template expression | PLA, A1 mini | CR-TPU |
| --- | --- | --- | --- |
| `{FTYPE}` | `filament_type` | PLA | TPU |
| `{FLUSHF}` | `flush_volumetric_speeds / 2.4053 * 60` | F299.339 | F79.8237 |
| `{FLUSHT}` | `flush_temperatures` | 240 | 250 |
| `{OW*60}` `{OW*100}` `{OW*400}` | the purge line's feeds, from `outer_wall_volumetric_speed` | F720 / F1200 / F4800 | F192 / F320 / F1280 |
| `{PLA?a:b}` | `{if filament_type == "PLA"} a {else} b {endif}` | a | b |
| `{?PLA}` `{?PLAHOT}` | a line the template writes only for PLA (and a bed over 45) | kept | dropped |

`outer_wall_volumetric_speed` is the outer wall's speed times its bead, never over the filament's
limit. The PLA slice only shows the PLA side of each `{PLA?a:b}`; the other side is read off
`machine_start_gcode` in the printer's template and stated beside its rule. `freeze.js` still
thaws each block with the slice's own values and requires the slice's own lines back, so PLA is
unchanged (`print:planner`).

**The TPU side is checked against Studio on both printers.**
`fixtures/print-planner/<printer>/studio-generic-tpu-tower.gcode.3mf` is the owner's temperature
tower as Studio 02.09.01.70 sliced it: Generic TPU @BBL A1M at 240 C on a 30 C bed for the A1 mini,
Generic TPU at 240 C on a 35 C bed for the P1S. `print:slice` (3c and 5) thaws NSO's start block
with each slice's numbers and requires Studio's lines back (472 and 269), and the filament start
G-code after it. The P1S slice is why a `{?PLA}` line is absent for another filament, not empty:
Studio's TPU start has none of the PLA fan block's four lines.

The planner also reads the filament's own retraction (`filament_retraction_length`, where it is
not `nil`): Studio's TPU slice retracts 0.4 mm while its CONFIG_BLOCK still says
`retraction_length = 0.8`, and NSO writes the same. The CONFIG_BLOCK holds a changed per-filament
value once per slot.

## Temperature steps

`plan(res, { tempSteps: { stepC, bandMm } })`. A layer whose underside is at or above
`n x bandMm` prints at `nozzle_temperature + n x stepC`; the first layer keeps its own
temperature. Each change is one line at the layer change:

    M104 S235 ; NSO temperature step

M104, not M109: the nozzle does not park on the part while it settles. A step that leaves the
filament's `nozzle_temperature_range` is refused with the height it happens at, not clamped. The
card's readout lists the bands as written, and `stats.tempBands` holds them.

A temperature tower is then any model: temp 240, temp step -5, every 10 mm.

## Adding a filament

One entry in `FILAMENTS` (`app-print.js`) and one `<option>` in `#slice-set-filament`
(`index.html`). Start from the Studio profile it inherits, then put measured values on top and say
where they came from. `tools/print-slice-check.js` section 3c is the pattern for its checks.
