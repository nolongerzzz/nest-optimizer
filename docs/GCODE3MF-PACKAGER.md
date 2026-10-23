# G-code 3MF packager: a G-code string in, a Bambu `.gcode.3mf` out

Module: `nso-gcode3mf-write.js` (`NSO_Gcode3mf.write`, `writeDetailed`, `describe`, `read`, `md5`)
Reference: `fixtures/supports/top_clip_x2_supports.gcode.3mf` (Bambu Studio 02.08.02.61, A1 mini 0.4)
Gate: `npm run gcode3mf:test` (`tools/3mf-test/gcode3mf-check.js`)

## Goal

Phase 2a of the export/print plan. The module writes a Bambu-shaped sliced
project from a G-code string plus the plate's metadata. Two later phases hand
their G-code here:

- **Phase 2b (salvage)** cuts an existing file at layer N and re-sends it.
- **Phase 4** is NSO's own print path: `nso-print-planner.js`
  (`docs/PRINT-PLANNER.md`) writes the G-code and calls this module.

The module has no UI, no slicer and no printer link. It runs in the browser and
in Node, like `nso-3mf.js`. It reuses that file's ZIP writer and CRC32
(`NSO3MF.buildZip`, `NSO3MF.crc32`), imported rather than copied. Reading back
uses `NSO3MFRead.openZip`. In the page, load `nso-3mf.js` and
`nso-3mf-read.js` first. `index.html` does not load this module yet.

## Call

```js
const bytes = await NSO_Gcode3mf.write({
  gcode,                       // the plate's G-code, written as given
  config,                      // project_settings.config: its text (verbatim) or its object
  objects: [{ identify_id, name, skipped }],
  printer: { model_id, nozzle },          // optional for the A1 mini
  estimate: { seconds, grams, firstLayerSeconds },   // fills what the G-code lacks
  filaments: [{ type, color, tray_info_idx }],       // per slot; fills what the G-code lacks
  thumbnails: { plate, plate_small, no_light, top, pick },  // PNG bytes, optional
  date: 'YYYY-MM-DD'           // 3dmodel.model's dates; default today (UTC)
});                            // -> Promise<Uint8Array>
```

- **`write` returns a Promise.** That is because `buildZip` deflates through
  `CompressionStream`.
- **`writeDetailed`** also returns the resolved fields and the text of each part.
- **`describe(opts)`** returns the fields alone, without writing a file. Its
  `sources` record where each field came from: `gcode`, `config`, `passed`,
  `default` or `placeholder`.
- **`read(bytes)`** returns the fields from a `.gcode.3mf`: the G-code and its
  MD5 check, `slice_info`, `plate_1.json`, `model_settings`, project settings
  and `filament_sequence`.

## The parts, in the reference's order

| part | what is written |
| --- | --- |
| `[Content_Types].xml` | the reference's bytes |
| `Metadata/plate_1.png`, `plate_1_small.png`, `plate_no_light_1.png`, `top_1.png`, `pick_1.png` | the caller's thumbnails; else **placeholder**: blank, fully transparent RGBA PNGs at the reference's sizes (512, 128, 512, 512, 512) |
| `Metadata/plate_1.json` | each object's layer-1 footprint, the bed, the filaments, the nozzle (float32, as Studio writes it), `version` 2 |
| `3D/3dmodel.model` | the header only, with no meshes: `Application` `BambuStudio-<the G-code's slicer version>`, and Studio's metadata in its order |
| `Metadata/project_settings.config` | the config, verbatim. An object is written as 4-space JSON plus a newline, which is byte-identical to Studio's |
| `Metadata/plate_1.gcode.md5` | uppercase hex MD5 of the G-code's bytes |
| `Metadata/plate_1.gcode` | the G-code, as given |
| `Metadata/_rels/model_settings.config.rels` | points to `plate_1.gcode` |
| `Metadata/model_settings.config` | the plate block: `gcode_file`, the thumbnail files and `pattern_bbox_file` |
| `Metadata/cut_information.xml` | one uncut entry per object |
| `Metadata/slice_info.config` | printer, prediction, weight, objects, filament, nozzle, `layer_filament_lists` |
| `Metadata/filament_sequence.json` | the filaments used, in order of first use |
| `_rels/.rels` | the model, plus the cover thumbnails (`rel-1`, `-2`, `-4`, `-5`, as the reference has them) |

## Read from the G-code first

Bambu's G-code carries most of what the metadata says. Those fields are read
from it, and a passed value only fills a field the G-code lacks:

- **HEADER_BLOCK**: the slicer version, the total layer count, the total
  estimated time (`prediction`), the filament weight and length, the model
  label ids, `max_z_height`, the filaments used, and
  `support_material_on_wipe_tower`.
- **CONFIG_BLOCK**, read before the passed config:
  - nozzle diameter and volume type
  - filament colours, types and ids
  - filament map and map mode
  - bed type, printable area and height
  - layer height
  - `exclude_object` (which sets `label_object_enabled`)
  - `enable_support`, `timelapse_type`, `extruder_type`, `print_sequence`
  - load and unload times
- **The body**:
  - layers: `; CHANGE_LAYER`
  - labels: `; start printing object, unique label id`
  - the footprint: each object's layer-1 extrusion, with every point widened
    by half its `; LINE_WIDTH` and arcs sampled
  - filament changes: `M620 S<n>A`
  - pauses: `M400 U1`
  - support: `; FEATURE: Support`

Each label id in the G-code is named by the passed object with that
`identify_id`. If the passed objects do not all carry the G-code's ids, they
are named in order. If the counts differ, the write is refused.

`printer.model_id` is the one field the G-code never carries. The only id on
record is A1 mini = `N1`, from the reference. Any other printer must pass it,
until a fixture proves its id and adds it to `MODEL_IDS`.

## Placeholders

Where NSO has no real value, the module writes one of these, and the gate
pins each:

| field | written | Studio writes |
| --- | --- | --- |
| thumbnails (5 PNGs) | blank, transparent, at the reference's sizes | renders of the plate |
| `slice_info` `first_layer_time`, `plate_1.json` `first_layer_time` | `0.000000` / `0`, unless `estimate.firstLayerSeconds` | its estimate (45.030609 on the reference) |
| `slice_info` `<warning>` lines | none | its slicing warnings (the reference has two `not_support_traditional_timelapse`) |
| `plate_1.json` `bbox_objects[].id` | the G-code label id | its runtime object id (4079/4080 against labels 4044/4066) |
| `plate_1.json` `bbox_objects[].area` | the footprint's bbox area | the slice polygon's area (equal for the reference's rectangle; 658 against 578 for its tree support) |
| `3dmodel.model` `DesignerUserId` | empty | the signed-in user's id. That id belongs to the owner and is not NSO's to stamp into every file |
| `slice_info` `enable_filament_dynamic_map`, `has_filament_switcher` | `false` | `false` on the reference |

The bboxes are read from layer 1's extrusion, while Studio's come from the
slice. They agree to within 0.15 mm; on the reference the worst difference is
0.01 mm, where a layer-1 arc bulges past its polygon. The gate holds the 0.15 mm.

## MD5

`crypto.subtle` has no MD5, so the module carries an RFC 1321
implementation (about 40 lines). It hashes full 64-byte blocks in place from
the caller's bytes and pads only the tail. The gate checks it against:

- RFC 1321's seven vectors
- `node:crypto` on every length from 0 to 200, the block edges and 64K, from
  an unaligned view
- the reference's own `plate_1.gcode.md5`

## The gate (`gcode3mf:test`)

The gate re-packages the reference. It unzips the file with Node's zlib, with
CRCs checked and none of the writer's code. It takes the reference's
`plate_1.gcode`, `project_settings.config` and object list, writes a new file,
and holds it to the reference:

1. **MD5**, as above.
2. **The part list**: the reference's 17 parts, in its order.
3. **Byte-identical parts**:
   - `[Content_Types].xml`, `_rels/.rels`
   - `plate_1.gcode`, its `.md5`, `project_settings.config` (as text and as
     an object)
   - `model_settings.config` and its rels
   - `cut_information.xml`, `filament_sequence.json`
4. **`3dmodel.model` and `slice_info.config`**: the reference's, line for
   line, except for the placeholders above.
5. **`plate_1.json`**: every field the reference has, with the bboxes within
   0.15 mm and the placeholders pinned. `estimate.firstLayerSeconds` fills
   `first_layer_time` in both parts.
6. **Thumbnails**: the placeholders are valid PNGs, fully transparent, at the
   reference's sizes. Passed thumbnails are written verbatim.
7. **The G-code first**:
   - Wrong passed values (1 s, 99 g, a 0.6 nozzle, PETG, ids 1/2) lose to the
     G-code.
   - With the HEADER_BLOCK stripped, the passed estimate fills time and
     weight, and the body still gives the layers, the labels, max_z and the
     filament.
8. **Round trip**:
   - `read()` returns the fields. The reference reads back the same way,
     except for its placeholders.
   - G-scope's import route (`NSOGcodeLines.readSlicedGcode3MF`) reads the
     same toolpath from the written file as from the reference: 26 233 moves
     in 10 features.
9. **Determinism and refusals**:
   - Two writes are byte-identical.
   - Each of these is refused: no config, an object count that differs from
     the labels, and a printer with no model id on record and none passed.

The gate also ran once in Chromium during development, with the module loaded
as a classic script beside `nso-3mf.js` and `nso-3mf-read.js`. It wrote the
file and read it back, and the MD5 matched the reference.

## Not yet

- Real thumbnails: NSO's plate render, at the reference's sizes.
- A first-layer time estimate.
- Model ids for printers other than the A1 mini, one fixture each.
- `layer_filament_lists` for multi-filament prints.
  - Its grouping (one entry per filament set, with that set's layer ranges
    concatenated) follows the single-filament reference.
  - No multi-filament fixture proves it yet.
- The owner's real gate: send a re-packaged file to the A1 mini and print it.
