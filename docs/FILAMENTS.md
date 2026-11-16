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

- **215 C** nozzle, **235 C** the first layer (since 2026-11-15; 235 throughout before). The tower
  said 240 - 235 for walls and 210 - 215 for bridges; the string test and the roof prints below settled
  it at 215 once the slicer printed islands one at a time and anchored its bridges.
- The bed is Studio's own for the printer, which is what that tower printed on: **30 C** on the
  A1 mini (`Generic TPU @BBL A1M`), **35 C** on the P1S (`Generic TPU`).

Not yet measured for this spool: the real max flow (3.2 is Studio's conservative Generic value),
retraction beyond 0.4 mm and the flow ratio. The P1S entry is the same keys with its own bed and
has not been printed: its 215 is the A1 mini's.

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

## Bridges and stringing

Seven more rows on the Print card (2026-11-14). The first three are the process's and start at the
printer profile's values; the other four are the filament's, and an empty one is the filament's own.

| Row | Section | Bambu key | PLA profile | CR-TPU |
| --- | --- | --- | --- | --- |
| **Bridge speed** | Quality | `bridge_speed` | 50 mm/s | 50 (prints at 39.3 over open air) |
| **Bridge flow** | Quality | `bridge_flow` | 1 | 1 |
| **Bridge temp** | Quality | NSO's own (see below) | off | off |
| **Flow ratio** | Printer and filament | `filament_flow_ratio` | 0.98 | 1 |
| **Retraction length** | Printer and filament | `filament_retraction_length` | 0.8 mm | 0.4 mm |
| **Retraction speed** | Printer and filament | `filament_retraction_speed`, `filament_deretraction_speed` | 30 mm/s | 30 mm/s |
| **Z hop** | Printer and filament | `filament_z_hop` | 0.4 mm | 0.4 mm |

- **A bridge's speed is the row's, never over what the filament's max flow allows its strand.**
  Over open air the strand is a line of the layer's height (0.45 x 0.2): at 3.2 mm^3/s that is
  39.3 mm/s, so for CR-TPU only a Bridge speed under 39.3 changes anything. Over sparse infill it is
  the round strand of the nozzle's diameter (25.5 mm/s). Bridge flow scales either. The card says
  so under the rows when the max flow is what holds the bridges.
- **The retraction rows are the filament's own keys**, as Studio writes them: the printer's
  `retraction_length`, `retraction_speed` and `z_hop` stay as they are in the file, and the planner
  uses the filament's where it names one (`settingsFrom`: `own()`).
- The readout after a slice gives the numbers as printed:
  `bridges 12 mm/s (flow 0.9), flow ratio 1, retract 0.8 mm at 30 mm/s, z-hop 0 mm`.
- Saved settings keep all six.

Not built: "avoid crossing walls" on travels, and wipe distance as a row.

### What the first prints said (CR-TPU, A1 mini, 2026-11-14)

- **Slower bridges are worse.** Bridge speed 12 against the default's 25.5 mm/s left the strands
  hanging in curls: a soft strand laid slowly has no tension on it.
- **The direction was wrong, and that was most of it.** The level's roof is 30 mm long and 8 mm
  deep, open on both faces: only the two pillars hold it. Studio lays that bridge lengthwise,
  pillar to pillar (lines up to 31 mm). NSO laid it at the solid infill's 45 degrees, lines
  8 - 11 mm long with both ends in the air: those are the loops. The slicer now lays a bridge over
  open air across its gap (docs/SLICER.md "A free bridge's direction").
- **Temperature is second.** In Studio's tower, with the bridge laid right, the 210 C band bridged
  clean and the 235 - 240 C bands sagged.
- **The second print (direction fixed, Bridge temp 215):** most of the bridge drew tight; the first
  perimeter over the gap hung low, and the bridge still drooped as a bundle. The file against
  Studio's, same layer: NSO printed the walls over the gap at 10 mm/s in 0.2 mm moves where Studio
  prints each as one move at the bridge's speed, and laid the bridge as a 0.4 mm round strand at
  25.5 mm/s where Studio lays a line of the layer's height at 41.6. Both are Studio's now
  (docs/SLICER.md "A wall over a gap", "A bridge's strand, by its kind"). An untouched CR-TPU
  bridge over open air prints at 39.3 mm/s.
- Retraction 0.8 mm against 0.4 did not change the stringing.

## Bridge temperature

**Bridge temp** (Quality; empty: off) prints a layer's bridges at their own nozzle temperature.
A hotend takes tens of seconds to move 25 C, so the change is made off the part
(`nso-print-planner.js` `parkAt`, `opts.bridgeTemp`):

    ; NSO bridge temperature: 212 for the bridges
    G1 Z2.6                           lift 0.4 (or the z-hop, if more)
    G1 X0 Y90 F18000                  the printer's park: the A1 mini's purge position,
    G1 X-13.5 F3000                   by the moves its timelapse hook makes every layer
    M109 S212                         wait there
    G1 E1.4 F79.8237                  the retraction back and 1 mm more, at the flush speed
    G1 E-.4 F1800                     retract
    G1 X0 F30000 ;wipe and shake      the start block's own wipe, all three passes
    G1 X-13.5 F3000                   (two left a tail of TPU on the part)
    G1 X0 F30000 ;wipe and shake
    G1 X-13.5 F3000
    G1 X0 F12000 ;wipe and shake

then the travel to the layer's first path, the nozzle down, and the filament forward.

- **A whole stretch, one change in and one out** (the owner's first print with it, 2026-11-14,
  cooled for the bridge lines and came back up for the fill beside and over them, layer after
  layer: six changes on one tower level). A layer with bridges prints whole at the bridge
  temperature - its walls over the gap and its fill too - and so does the layer over it, which is
  laid straight onto the bridge. The layer after that the same block brings the layer's own
  temperature back (`... 235 after the bridges`). Both changes are made at a layer change.
  Stretches two layers apart or less are one.
- **Only a bridge over open air counts** (the slicer's `path.free`), 10 mm of it or more in the
  layer. A bridge over sparse infill is held from below every few millimetres and prints well hot;
  it used to cost a pair of waits near the top of every part.
- The park is outside every object's M624 / M625, so skipping an object does not skip the change.
- With temperature steps, "after the bridges" is the band's temperature.
- **From a layer on** (the card's **Bridge temp from layer**, `opts.bridgeTempFrom`; the preview's
  layer numbers, the first is 1): every layer from that one to the top prints at the bridge
  temperature - one change at the park going in, none coming out. For a part whose walls want it
  hot and whose roof wants it cool: the owner's CR-TPU tower level of 2026-11-15, 235 C (240 the
  first layer) for the walls under the roof and 215 from layer 36, the layer after the cone's tip,
  through the bridge and the roof. Empty: only the bridges' own stretches. It needs a Bridge temp.
- Refused, in words: a bridge temperature outside the filament's range; any printer but the A1 mini
  (`PARK` holds each printer's own moves, and the P1S's chute, behind the bed, is not written).
- The print's time counts 15 s a change: the owner timed the wait at 10-12 s on the A1 mini (235 to 215 and back), and the moves are added.
- The readout: `bridges at 215 °C on 1 layer: 2 nozzle temperature changes at the park, about 1 min`.
- The owner's tower level: two changes a level (in at the roof's bridge layer, out two layers on).

Not printed yet. What a print has to show: that the strand starts clean after the wait (the prime
and wipe are a first guess), and how long the mini really takes for 235 to 212 and back.

## Stringing: what the string test said (2026-11-14)

The owner printed a two-cone string test in CR-TPU on the A1 mini five ways. The baseline (235 C,
0.4 mm retraction, 0.4 mm Z hop) was clean for the bottom two thirds and strung where the layers get
small. 225 C was worse, from the first layers up; 245 C was no better; no Z hop was no better. What
changed it was the slicer's order - one island, then the next (docs/SLICER.md) - which takes the
cones from five crossings a layer to one. With that order the cooler prints won: 210 and 220 were
nearly clean (210 bonded solid, no give when pulled apart), 215 between them, and 235 strung top to
bottom.

### Locked: 215 C, no bridge temperature (2026-11-15)

A tower level at a flat 210 and then 215 C (Bridge temp off) dropped the roof's lines into the window.
The roof was not anchored: its bridge lines stopped at the gap's edge, and a strip was left open along
the front wall (docs/SLICER.md "A bridge reaches onto what holds it", "A bridge fills its gap wall to
wall"). With both fixed the same level at a flat 215 printed the owner's best bridge so far, the
window's inside clean; a little sag on the front lip. So CR-TPU prints at 215 (first layer 235) and
asks for no bridge temperature: no stop at the park. Bridge temp stays on the card for a job that
wants it.

### No fill piece under 1 mm (2026-11-15)

CR-TPU carries one slicer rule of its own (`slicer: { shortFillMm: 1 }`): a fill piece shorter than
1 mm is not laid, so no prime and retraction is spent on a crumb at a corner (docs/SLICER.md "No
crumbs"). The owner's lead-in print of the tower level had the back edge clean but a looser lip than
the clean-lip print before it, whose layers below the roof it matches move for move: what changed
there was the print, not the file.

### Retract before wipe (the card's row, `filament_retract_before_wipe`)

Bambu's profiles pull the retraction along the wipe: the nozzle moves back over the wall it has just
laid while the filament comes out of it. On a small hot TPU layer that is a nozzle still under
pressure dragging through soft plastic. The row is Bambu's `retract_before_wipe`, a per cent: that
share is pulled standing still at the end of the line (`G1 E-.4 F1800`), then `; WIPE_START`, and
the rest along the wipe. At 100 the wipe is bare moves. Empty is the filament's own (0 so far, for
every filament: not printed yet, so not CR-TPU's own). `nso-print-planner.js` `flushRetract`,
`S.retract.beforeWipe`; checked in `print:slice` 3c.

## The filament holds its dials

The owner (2026-11-14): TPU is what made these dials necessary, so they belong to the filament -
picking it is all a TPU job should need, and nothing outside that filament moves.

A `FILAMENTS` entry has, beside its Studio keys, `tune(config)`: its own values for the rows that
are not a filament key in Studio - **Bridge speed**, **Bridge flow**, **Bridge temp**. Those three
rows now work like the other filament rows: empty is the filament's own, picking a filament fills
them in, and a number typed in wins. For Bridge temp, 0 is "none" whatever the filament brings.

| | Profile (PLA) | CR-TPU, A1 mini | CR-TPU, P1S |
| --- | --- | --- | --- |
| Bridge speed | the profile's 50 | 50 | 50 |
| Bridge flow | the profile's 1 | 1 | 1 |
| Hanging wall speed | the bridge's speed | the bridge's speed | the bridge's speed |
| Bridge temp | none | none (it prints at 215) | none (no park moves written) |

- CR-TPU carried a Bridge temp of 215 on the A1 mini from 2026-11-14 (its nozzle was 235) until
  2026-11-15, when 215 became its nozzle temperature.
- On a printer with no park moves the filament asks for no bridge temperature, so CR-TPU still
  slices for the P1S; only a number typed into the row there is refused.
- What a slice is made with is `bridgeTempOf(config, settings)`; the card's note under the filament
  rows says what the filament brought.
- A tested value goes into the entry's `keys` (a Studio filament key) or its `tune` (the rest), with
  the print it came from beside it. Saved settings are still there for a job's own levers.

## Hanging wall speed (the card's row, 2026-11-15)

A wall that hangs over open air from end to end - the edge of a roof over a window - is found by the
slicer the way overhangs are (`spanPieces`, `path.span`, docs/SLICER.md "A wall over a gap") and
printed at the bridge's speed, as Studio prints it. For CR-TPU that is the max flow's 42 mm/s, and the
front lip of the owner's 215 level sagged there; his Studio reference printed those walls at 10.

**Hanging wall speed** (Quality, beside the bridge rows) slows just those walls: empty is the
filament's own (none brings one), else the bridge's speed; never faster than the bridge's
speed, and the max flow still holds it. The bridge lines keep their speed (slower bridges curled on
TPU), and walls that only partly hang keep the profile's overhang speeds (10 mm/s at 75-100 %). The
readout says "hanging walls 10 mm/s" when it applies. `app-print.js` `hangSpeedOf`, the planner's
`opts.hangSpeed` / `S.speed.hang`; checked in `print:slice` (the doorway).

CR-TPU carried 10 of its own for one print (2026-11-15): the lip no better, the bridges worse. So it
has none - its hanging walls print at the bridge's speed, as Studio's do - and the row stays for a
job that wants it.

## Bridges before the walls (`bridgeFirst`, being printed, 2026-11-15)

The owner watched the nozzle bend a CR-TPU lip down: on the roof layer the walls go first, the front
and back ones hanging over the window, and the bridge's first line then runs 0.36 mm beside the inner
one - the nozzle's face rides over the soft lip, presses it down, and the bridge welds it there. The
same at the slot over the cone. The slicer's `bridgeFirst` lays a layer's open-air bridges before its
walls (`nso_slicer.js`, before `islandOrder`), so the bridge is anchored on what holds it and touches
nothing, and the hanging walls are laid against a sheet. Off by default (walls first, as Studio);
settings `bridgeFirst: true` turns it on. Not on the card or in any filament yet: one print decides.

## Adding a filament

One entry in `FILAMENTS` (`app-print.js`) and one `<option>` in `#slice-set-filament`
(`index.html`). Start from the Studio profile it inherits, then put measured values on top and say
where they came from. `tools/print-slice-check.js` section 3c is the pattern for its checks.
