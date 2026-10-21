# Bambu project export: NSO's 3MF opens in Bambu Studio as a project

Module: `nso-3mf.js` (`build3MF`, `loadTemplate`)
Template: `fixtures/bambu-templates/a1mini-0.4/` (`project_test.3mf`, `template.json`)
Gate: `npm run export:bambu` (`tools/3mf-test/bambu-project-check.js`)

## Goal

NSO's 3MF should open in Bambu Studio as a **full project**: no
geometry-only warning, per-object overrides kept, and NSO's cooling keys shown
under Cooling. Bambu Studio loads a 3MF's per-object config and project
settings only when the file is its own project. Until now NSO wrote a minimal
3MF (`Application` "Nest Optimizer", meshes inline in `3D/3dmodel.model`).
Studio loaded that as geometry only, so `Plater::load_files` reset every
object's config and the support overrides were lost.

**Template, not invention.** NSO writes the envelope the owner's own Studio
wrote, part for part, and overlays only what NSO owns.

## The compatibility shim, on record

`3D/3dmodel.model` says `<metadata name="Application">BambuStudio-02.08.02.61</metadata>`,
even though NSO wrote the file.

- **Why it is deliberate.** Studio loads a 3MF as a project only when Studio
  wrote it, and that tag is how Studio tells.
- **The version** is the pinned template's, **02.08.02.61**, as recorded in
  `fixtures/bambu-templates/a1mini-0.4/template.json` (`studio_version`). It is
  never newer than that.
- **Two checks hold it:**
  - `loadTemplate` refuses a template whose own Application tag differs from
    its record.
  - `export:bambu` **fails** if the tag an export writes ever differs from the
    fixture's recorded version. It also checks the template's project settings
    `version` and its `slice_info` client version against that record, and the
    file's sha256 against the one recorded.
- **To move to a newer Studio**, the owner saves a new template in that
  Studio and drops it in with its record. The writer never invents a version.

## Template policy

- **One template per printer + nozzle**: `fixtures/bambu-templates/<key>/`,
  holding a project Studio saved, **unsliced**, and `template.json`:

  | field | holds |
  | --- | --- |
  | `printer` | the printer |
  | `nozzle` | the nozzle size |
  | `studio_version` | the Studio version that saved the file |
  | `file` | the project file's name |
  | `sha256` | the project file's hash |
  | `source` | where the file came from |

  A sliced template is refused, because its G-code would ride into every export.
- **A1 mini 0.4** (`a1mini-0.4`) is the default and the only template so far.
  It is the owner's `project_test.3mf`: top_clip_x2 and one tree support,
  Generic PLA @BBL A1M, 0.20mm Standard @BBL A1M.
- **The P1S template** will be a fixture drop and needs no code: a
  `p1s-0.4/` directory, picked with `build3MF({ template: 'p1s-0.4' })`. Choosing
  it from the printer is later work.
- **Filament and cooling keys** come from NSO's own profiles
  (`nso-cooling-profiles.js`) and are overlaid onto the template's.
- The app reads the template with `fetch` from the same site (`fixtures/` ships
  with the page). Node reads it off disk. Both open it with
  `nso-3mf-read.js`, and the result is cached per key.

## The envelope, part for part

Parts are written in the template's order. NSO's two parts go last.

| part | what NSO writes |
| --- | --- |
| `[Content_Types].xml`, `_rels/.rels` | the template's bytes |
| `Metadata/plate_1.png`, `plate_1_small.png`, `plate_no_light_1.png`, `top_1.png`, `pick_1.png` | the template's bytes: fixture data, not a picture of the export's plate (*Trim later*) |
| `Metadata/slice_info.config`, `Metadata/filament_sequence.json` | the template's bytes |
| `3D/3dmodel.model` | the template's root element (`xmlns:BambuStudio`, `requiredextensions="p"`) and its metadata in order. Application is the template's tag; CreationDate and ModificationDate are the export date; DesignerUserId is blank (it is the template owner's account). One `<object id="2N">` per piece holds one `<component>` pointing at `/3D/Objects/object_N.model` (object `2N-1`), identity transform. **No mesh.** `<build>` has one `<item objectid="2N">` per piece, whose translation is the piece's placement, `printable="1"` |
| `3D/_rels/3dmodel.model.rels` | one relationship per object part |
| `3D/Objects/object_N.model` | piece N's mesh **centred on its own origin** (its bounding-box centre, at the writer's 6 dp, so centre + vertex prints back to the vertex), object `2N-1`, `<build/>` |
| `Metadata/project_settings.config` | the template's keys (581 for a1mini-0.4) in its order, with NSO's 14 cooling keys overlaid on **every filament slot** (the template has two). `version`, `printer_model` and the preset ids are the template's. Written as Studio writes it: 4-space JSON |
| `Metadata/model_settings.config` | project shape. Per object: its name, then its own config in key order (the extruder, which is the template's `1`, plus any per-object overrides), `face_count`, and one `<part subtype="normal_part">` with name, identity `matrix`, `source_file` / `source_object_id` / `source_volume_id` / `source_offset_*`, and `mesh_stat`. The plate block's metadata is the template's (filament maps, thumbnail names), with one `<model_instance>` per piece: `object_id`, `instance_id` 0, **`identify_id`**. Then `<assemble>`, two items per object, the instance's transform the build item's |
| `Metadata/cut_information.xml` | one `<object id="N">` per piece, uncut |
| `Metadata/plate_1.json` | the template's fields. `bbox_objects` has one entry per piece: its first layer, meaning its faces lying on the plate, as `bbox` and `area`, plus its `identify_id`, the template's layer height and its name. `bbox_all` is their union. `first_layer_time` is 0, because NSO has not sliced; Studio rewrites the file when it slices |
| `Metadata/nso_profile.json` | NSO's provenance, as before |
| `Metadata/nso_scene.json` | NSO's scene, when one is given, as before |

### UUIDs

These are Bambu Studio's counter form: eight hex digits plus Studio's fixed
suffixes (`bbs_3mf.cpp`), exactly as the template carries them.

| element | counter | suffix |
| --- | --- | --- |
| object (the wrapper) | N | `-61cb-4c03-9d28-80fed5dfa1dc` |
| sub-object (the mesh) | N << 16 | `-81cb-4c03-9d28-80fed5dfa1dc` |
| component | N << 16 | `-b206-40ff-9872-83e8017abed1` |
| build item | 2N (the wrapper's id) | `-b1ec-4553-aec9-835e5b724bb4` |

`<build>` and each `<part>` carry a v4-shaped UUID derived from the plate, so the
same plate exports byte for byte the same.

### identify_id

The template shows that Bambu reads `identify_id`: Studio keeps it as the
instance's id and labels the object with it in G-code. NSO now writes one per
instance:

- An object's own `identifyId` (a positive integer) is used when the caller
  passes one.
- Otherwise the id is derived from the piece's name and face count (1-65535).
  The same plate exports the same ids, and a piece moved on the plate keeps its
  id.
- On a collision, the id steps to the next free one, in object order, so two
  copies of one piece get two ids.
- `build3MF` reports the ids it wrote (`identifyIds`).

This closes GRISPR limitation 4.

### Names

A project names its objects in `model_settings.config`. As in the template,
the `<object>` elements carry no `name` attribute. docs/3MF-OBJECT-IDENTITY.md's
`name` on `<object>` belongs to the geometry-only envelope, where Studio does
not read `model_settings.config`.

## Per-object overrides on support objects (decided)

Every support object carries one set: `NSO_SupportInterface.SHEET.slicerSettings`.

| key | value | why |
| --- | --- | --- |
| `wall_generator` | `classic` | the sheet's thin-wall pass (docs/SUPPORT-INTERFACE.md) |
| `detect_thin_wall` | `1` | the sheet's thin-wall pass |
| `top_shell_layers` | `0` | a support is its walls and its sheet: no shells |
| `bottom_shell_layers` | `0` | as above |

Nothing else. Per-family tuning waits for a print.

The Supports card puts the set on each support model (`m.slicerSettings`), and
both app exports carry it to the object's metadata.

## The fallback

When the template cannot be read, `build3MF` writes NSO's original
geometry-only envelope, and it does not throw. That happens when the page is
opened from `file://`, has no `fetch`, or has a refused template. The result
says so (`envelope: 'nso'`, `templateError`), and the console warns.
`build3MF({ envelope: 'nso' })` asks for that envelope outright. Otherwise the
default is `'project'`.

## Gates

- `export:bambu` covers the record and the guard (with a known-bad copy, made
  and removed in the run, which must be refused and must fall back). It then
  checks the export against the template:
  - the part list and order; the template's bytes where NSO writes none;
  - the skeletons (elements, attributes, metadata order) of `3dmodel.model`,
    its rels, an object part, `model_settings.config` and
    `cut_information.xml`;
  - the UUID counters and suffixes; each mesh centred and placed;
  - the support set on the support object alone;
  - the project settings key set, order, version and presets, with NSO's
    values on every slot;
  - `identify_id` present, unique and stable;
  - the geometry, read back by `nso-3mf-read.js`, where it was; a piece without
    overrides matches the geometry-only envelope's vertices.
- `3mf:roundtrip`, `3mf:drive`, `3mf:import`, `3mf:import-drive`, `3mf:scene`
  and `export:roundtrip` read the new envelope:
  - geometry through the object parts and build items;
  - names from `model_settings.config`;
  - the cooling keys on every filament slot of the template's file.
- **The real gate is the owner's, in Studio:**
  1. File > Open the export. There should be no geometry-only warning.
  2. Support objects show the override badge.
  3. Cooling shows NSO's values.
  4. Slice it: the supports print with their overrides.

## Trim later

The thumbnails, `slice_info.config`, `filament_sequence.json` and
`plate_1.json` are written as the template has them, as a start.
- `pick_1.png` and `top_1.png` picture the template's plate, not the export's.
- Studio redraws them when it slices or saves.

Once the owner's Studio check passes, each one can be dropped in turn, to find
which ones Studio needs.
