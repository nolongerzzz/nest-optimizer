# Print planner: NSO writes Bambu's dialect

Module: `nso-print-planner.js` (`NSOPrintPlanner.plan`, `toGcode3mf`, `settingsFrom`, `engineOptions`, `thaw`, `estimateLines`)
Frozen blocks: `fixtures/print-planner/<printer>/frozen.json`, made by `tools/print-planner/freeze.js`
Gate: `npm run print:planner` (`tools/print-planner/planner-check.js`)
References: `fixtures/supports/top_clip_x2_supports.gcode.3mf`, `simple_overhang_bambu.gcode.3mf` (A1 mini 0.4), `simple_overhang_p1s.gcode.3mf` (P1S 0.4) - the owner's Studio 02.08.02.61 slices

## Goal

A `.gcode.3mf` that Bambu Studio opens as a project and sends to the printer
**without slicing it again**. The planner and the packager are engine: no G-scope
file loads them. The one door to them is the left bar's Slice card
(`app-print.js`, below). `nso_slicer.js`'s `toGcode()` is unchanged - it is
G-scope's own text (a toolpath to read), not a file to print.

```
sliceObjects()  ->  plan()  ->  gcode  ->  toGcode3mf()  ->  .gcode.3mf
 (shared engine)   template + NSO cooling   nso-gcode3mf-write.js (#270)
```

## What owns what

| | owner |
| --- | --- |
| speeds, accelerations, retraction, z-hop, wipe, temperatures, bed, flow ratio, volumetric limit | the printer template's project settings |
| the 14 cooling keys: fans, layer-time slowdown, overhang fan | NSO (`nso-cooling-profiles.js`); they win over the template's |
| machine start / end G-code, the filament start, the per-layer hooks, the CONFIG_BLOCK | Studio's own, frozen from the owner's slice of the template plate |
| the toolpath, its feature names (support paths typed `Support` / `Support interface` / `Support transition`) | the engine |

Templates: A1 mini 0.4 is `fixtures/bambu-templates/a1mini-0.4/` (the Phase 0
export's). The P1S has no unsliced project yet: its settings are the project the
owner's P1S slice carries (`simple_overhang_p1s.gcode.3mf`), and its model id
(`C12`) is the one in that slice's `slice_info.config`.

## The planner

`plan(res, { config, printer, cooling?, hooks?, labelIds? })` ->
`{ ok, gcode, layers, labels, stats }`. It refuses a plate off the bed or taller
than the printer, and a result without a first layer.

**Speed.** `v = min(feature speed, filament_max_volumetric_speed / bead area)`,
the bead being the stadium `nso-gcode-lines.js` inverts. This reproduces
Studio's own figures exactly: outer wall F9547.055 and inner wall F8843.478 at
0.42 / 0.45 mm lines, support F9000 (150 mm/s is under the limit). The first
layer takes `initial_layer_speed` (walls, supports) or `initial_layer_infill_speed`
(infill, bottom surface). A bridge is a round bead of the nozzle's diameter
(`; LAYER_HEIGHT` and `; LINE_WIDTH` both 0.4, as Studio writes it).

**Acceleration.** `M204` per feature from the template (`inner_wall_acceleration`
0 and absent keys mean `default_acceleration`), `travel_acceleration` for
travels, `travel_short_distance_acceleration` for a short one that does not
retract, `initial_layer_*` on layer 1; written only when it changes.

**E** = bead area x length / filament area x `filament_flow_ratio` (0.98).

**Retraction.** 0.8 mm at 30 mm/s, taken along a 2 mm wipe of the path just
printed (95 % of it during the wipe, the last 5 % as `G1 E-.04`), then a z-hop
of 0.4 mm and the deretraction at the next start. A travel inside the layer's
own section, or under `retraction_minimum_travel`, neither retracts nor hops; a
travel between objects always does. Retraction on a layer change follows
`retract_when_changing_layer`; the last wipe of a layer is written after the next
`CHANGE_LAYER`, as Studio does.

**Cooling.** `uniform_cooling` slows a layer under `slow_down_layer_time` to one
common speed (never under `slow_down_min_speed`); `quality_first` scales every
move by one factor. Bridges keep their speed; the first layer is not slowed. The
part-cooling fan runs between `fan_min_speed` and `fan_max_speed` by layer time,
off for `close_fan_the_first_x_layers`, 2 % dead band between layers
(`reduce_fan_stop_start_freq`); bridges and overhang walls get
`overhang_fan_speed` and the layer's fan is restored after. On a printer with an
auxiliary fan the planner writes `M106 P2` from `additional_cooling_fan_speed`.

## Start and end: frozen

`machine_start_gcode` and `machine_end_gcode` are Studio's template language.
NSO has no evaluator. `freeze.js` cuts the blocks Studio **expanded** for the
owner's slice out of the slice, and keeps them as text. Only what the template
computes from the plate is a token:

| token | the template's expression |
| --- | --- |
| `{N}` `{N-20}` `{N-40}` `{T}` | `nozzle_temperature_initial_layer` (and -20 / -40), `nozzle_temperature` |
| `{B}` | `bed_temperature_initial_layer_single` |
| `{BX}` `{BY}` `{BW}` `{BH}` `{CY}` | `first_layer_print_min / _size`, the first layer's centre Y |
| `{Z+0.4}` / `{Z+0.5}` `{Z+100}` `{Z+98}` | `max_layer_z` plus the amount; the end block's `{if (max_layer_z + 100) < cap}` pair |

Every rule says how many lines it must change. The tool thaws each block with
the slice's own numbers and requires the slice's lines back; `--check` also
requires the committed JSON to be a fresh freeze (the gate runs it). Literals
stay literal: the A1 mini's PLA flush at 220 and the P1S's 250 are the
template's, not the filament's.

What is therefore frozen with the plate it came from: the bed type (Textured
PEI: `G29.1 Z-0.02`), the filament start's fan by bed temperature, the
calibration lines' speeds (`outer_wall_volumetric_speed`), and the start's and
end's M73 positions (turned into `M73 P/R` from the planner's own time).
**Changing the bed type or the filament's volumetric limit means a new freeze
from a new Studio slice.**

## Markers

HEADER_BLOCK (the "cm^3" volume is mm^3 under Studio's label, as Studio writes
it), CONFIG_BLOCK (Studio's, with NSO's cooling keys put in), EXECUTABLE_BLOCK,
`MACHINE_START_GCODE_END` / `MACHINE_END_GCODE_START`, `M73 P/R` and `M73 L`,
`CHANGE_LAYER` / `Z_HEIGHT` / `LAYER_HEIGHT` / `M991`, and per object `OBJECT_ID`,
`start / stop printing object`, `M624 <mask>` / `M625`.

- **Labelling happens only when the plate has more than one object**, as in
  Studio: the owner's one-object A1 mini arc has `OBJECT_ID` per layer and no
  `M624`, no label ids in the header.
- **The M624 mask** is one bit per object, by its place in the plate's label
  order, as a 64-bit little-endian integer in base64: `AQAAAAAAAAA=`,
  `AgAAAAAAAAA=`, both `AwAAAAAAAAA=` (measured on the owner's two-object slice;
  the third, `BAAAAAAAAAA=`, follows the same law and is not confirmed - no
  Studio slice with three objects is in the repo).
- **The hook** (timelapse photo, nozzle-clog check) goes after the first run of
  walls in a layer, inside the union mask. Each of timelapse / clog / spaghetti
  can be left out per profile (`hooks: { timelapse: false }`); the default is the
  template's.

## Time

`estimateLines` times a G-code text from its own `F`, `M204` and moves: each run
of XY moves goes through the machine's look-ahead (classic jerk at the corners,
acceleration both ways, a trapezoid or a triangle per move). The planner times
the lines it wrote with it, so the `M73` markers, the header, `slice_info`'s
`prediction` and the layer slowdown's sums come from one model. Held to Studio's
own prediction by running it over Studio's own G-code: **0.958 / 0.971 / 1.029**
on the coupon, the A1 mini arc and the P1S arc. Studio ignores the timelapse
hooks' waits; so does this.

The start block's and end block's time are Studio's, from the slice's M73s
(340 s and 25 s on the A1 mini).

## Decisions the ticket did not make

- **The gap list** was not in the repo; this page's list below is the ticket's
  own itemisation.
- **P1S "template".** There is no unsliced P1S project. Its settings are the
  owner's P1S slice's; the frozen blocks come from the same file.
- **`simple_overhang_bambu.gcode.3mf`** was on three unmerged `supports-*`
  branches (the same blob on each); it is added here at the same path.
- **The CONFIG_BLOCK is frozen too** (Studio's, per printer), not rebuilt from
  `project_settings.config`: the two differ in the form of 18 keys on the A1 mini
  and ~100 on the P1S (quoted strings, per-slot collapsing, `;` or `,` joins),
  and the packager reads the block.
- **The end block needs `max_layer_z`**, so the substitution is more than
  temperatures and the first-layer box.
- **Engine options from the template** (`engineOptions(config)`): widths, wall
  loops, shell layers, density, thin walls. The engine has one infill width, so
  the sparse infill's 0.45 is used for solid and top as well (Studio: 0.42).
- **Overhang walls** print at `overhang_4_4_speed` (10 mm/s): the engine does not
  grade how far one hangs. Studio's own figures are 10 and 50.
- **Support transition** prints at `support_speed`.
- **Spiral lift** (`G17 G3 ... P1`) at layer changes and at the hook, radius
  1.2 mm (Studio's runs 1.217); a lift between islands is a sloped travel.
- **Fan time** is the unslowed layer time; Studio's layer-2 fan figure
  (S201.45) implies a slightly different time, so the fan values differ by a few
  percent.
- **Label ids** are 1001, 1002 ... (Studio uses its runtime ids; `labelIds`
  overrides).
- **`overlayProjectSettings`** is exported from `nso-3mf.js` (one line; its
  `?v=` is bumped) so the `.gcode.3mf` carries the template's settings with
  NSO's cooling keys on every slot, `different_settings_to_system` included.

## The gap list

What Studio's file has that `toGcode()`'s text does not, and where each landed.

| | status |
| --- | --- |
| per-feature `F` (outer, inner, sparse, solid, top, first layer, travel, support, interface, bridge, gap) | **landed** (gap infill has a speed; the engine makes none) |
| `M204` per feature | **landed** |
| retraction 0.8 @ 30, z-hop 0.4, retract on layer change, wipe | **landed** |
| nozzle and bed temperatures from the template filament | **landed** (in the thawed start block, and `M104` / `M140` on layer 2 if they differ) |
| fans from the cooling keys, per-layer slowdown | **landed** |
| machine start / end, per printer | **landed**, frozen (A1 mini, P1S) |
| HEADER / CONFIG / EXECUTABLE blocks | **landed** |
| `M73 P/R`, `M73 L`, `M991` | **landed** |
| `OBJECT_ID`, `start/stop printing object`, `M624` / `M625` | **landed** (labelled plates only, as Studio) |
| `; FEATURE` names exactly Bambu's, supports typed | **landed** |
| spaghetti / timelapse / clog hooks per profile | **landed** |
| time model for `M73` and `slice_info` | **landed** (within 5 % of Studio's on its own G-code) |
| `Gap infill`, `Floating vertical shell` | **not landed - the engine**: it makes neither (Studio: 133 and 9 layers on the arc) |
| first layer's 0.5 mm line | **not landed - the engine** has one width per path set |
| solid vs sparse in a narrow body | **not landed - the engine**: the coupon's 15 % sparse is solid infill in NSO (56 layers) |
| arc fitting (`G2` / `G3` for curves) | not landed: `G1` only, so the files are larger |
| graded overhang speeds | not landed (see decisions) |
| variable / adaptive layer height | not landed: the engine's layers are uniform |
| seam placement, scarf joints, ironing, brim / skirt, pressure advance | not landed (the template has them off or `auto`) |
| multi-filament, AMS | not landed: one filament |
| one-object plates: `plate_1.json` footprints | **landed**: layer 1's extrusion is the footprint when the G-code has no labels (`docs/GCODE3MF-PACKAGER.md`) |
| real thumbnails | not landed (placeholders, the packager's) |

## The Slice card (print-slice-main-plate)

`app-print.js`, `#menu-slice`. A SLICE button in the left bar's bottom stack
(Slice, G-scope, Check & repair, top to bottom) opens a card shaped like the other
left-bar cards (a `details.vp-menu`, one open at a time). It is UI only and download
only: no Send, no printer link, no settings.

- **What it does.** Slices every piece on the plate, supports included, for the
  plate's printer profile, and reads out layers, estimated time and filament grams.
  Then **Export .gcode.3mf** downloads the packaged file and **Preview in G-scope**
  opens that same file through G-scope's existing `.gcode.3mf` import
  (`NSO_MICROSCOPE.openFile`), read-only, so the supports show as Support /
  Support interface / Support transition. A plate the planner refuses (off the bed,
  too tall, no first layer) shows the planner's reason in the card.
- **The printer profile** is the plate picker's plate, read, not edited:
  `a1mini` -> A1 mini 0.4 (`fixtures/bambu-templates/a1mini-0.4/project_test.3mf`,
  `fixtures/print-planner/a1mini-0.4/frozen.json`); `a1` ("A1 / P1S / X1C 256") ->
  P1S 0.4 (the project inside `fixtures/supports/simple_overhang_p1s.gcode.3mf`,
  `fixtures/print-planner/p1s-0.4/frozen.json`). Any other plate has no profile and the
  card says so. The template's values are used as they are. Print settings live
  here, per printer profile; they never read or write G-scope's Slice settings.
- **The plate becomes the engine's input** through G-scope's `plateObjects()` (a
  read of the plate, not an edit of G-scope): each piece's Z-up soup, moved by half
  the printer's bed (the viewport's plate is centred on 0,0, a bed starts at its
  corner), a support carrying its host and `role: 'support'` (the engine types its
  paths; the UI retypes nothing), a non-solid piece sliced with its open edges open.
  The engine's options are the template's (`engineOptions(config)`).
- **The slice runs on a worker** (it loads the engine files the page loaded, found
  from the page's own `<script>` tags), so the page stays alive; the card shows the
  stage ("Slicing 3 objects", "Writing the G-code and packing the file") and the
  seconds, with no invented percent, and Cancel ends the worker.
  `tools/nso_slice_pool.js` is the Node-only pool and is not used.
- **Stale.** Export and Preview exist only for a slice of the plate as it stands; a
  piece moved, added or removed, or another plate picked, greys them and says so.
- **Static files.** The frozen blocks and the template are fetched when Slice is
  pressed; a missing one says which path and that `fixtures/` must be served.
- **Gate:** `npm run print:slice` (`tools/print-slice-check.js`): the plate with
  supports through `build()` -> a `.gcode.3mf` whose FEATURE lines carry Support,
  Support interface and Support transition, the packager's checks, the refusals,
  the coupon on the P1S, the markup and the load order. The browser drive of the card belongs to
  the audit driver, not to `testSteps`.
- **Not wired:** a settings panel; Send / a printer link; supports on the card (the
  Supports card is separate: Slice works on what is on the plate); a profile for the
  Prusa, Ender and Custom plates.

## Owner test

Open the downloaded file from the Slice card in Bambu Studio's preview: the supports
show as support.

After the PR: one small coupon on the A1 mini, watched; then the two-piece plate
with NSO supports. Watch the first layer (a 0.42 mm line where Studio's is 0.5),
the first retraction and z-hop, and that the head lifts clear at the end.

## Supports on their own layer grid

A Dense support (`sheetLayerMm` 0.275 in its meta) is sliced on its own layer grid (`supportLayerMaxMm` 0.28, see docs/SLICER.md), as G-scope's Slice does. The Print card sets the option the same way (`build()` in app-print.js), and `plan()` first puts the objects' grids into one timeline (`alignGrids`): every height any object prints at, ascending, each object's layers on the heights it has. A slice with no own grids passes through untouched. A bead takes its own layer's height, so the gcode carries a `; LAYER_HEIGHT` line where a support's layer differs from the part's. Checked on the real page with `node tools/nso_support_plate_page_slice.mjs out.json print.gcode.3mf` (Generate, Print card Slice, save the file): the six supp_ref supports start their transition/interface at Bambu's heights.
