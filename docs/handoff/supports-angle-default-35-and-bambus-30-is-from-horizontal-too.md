## Supports angle default - 35, and Bambu's 30 is from horizontal too (2026-10-21)
Branch `claude/supports-angle-default`, off `claude-wip` 6f3354f. No engine change:
`app-supports-card.js` (`ANGLE_DEFAULT`, `BAMBU_ANGLE`, the label), `index.html`
(the field's value, tooltip, label), docs, the fixture, and the checks that built
"at the card's defaults" with 60.

- **The finding (owner's measurement).** On the Simple Overhang Test (an arc
  whose underside steps 10, 20 ... 80 deg off horizontal), Bambu Studio, tree
  slim, threshold 30, supported only the arc's underside within 30 deg of
  HORIZONTAL - z 41.4 - 46.2, 254 mm^2 (its support transition / interface
  layers, read from the owner's slice: z 41.4 - 46.2) - and printed the 40 - 60
  deg stretch (175 mm^2) as overhang walls, no support. The card's "60 deg -
  Bambu 30 deg" assumed Bambu measures from vertical; it does not. NSO's angle
  already meant "faces within N deg of horizontal" (`n.z < -cos(angle)`), so
  Bambu's 30 is NSO's 30, and 60 asked for supports Bambu leaves out.
- **The change.** `ANGLE_DEFAULT` 60 -> 35 (owner: a hair more sensitive than
  Bambu's 30). The label is the card's number and Bambu's default side by side,
  "35 deg - Bambu 30 deg" - no more 90 minus. The tooltip says what the number
  means: "Faces within this many degrees of horizontal get support."
- **The arc, measured** (`support:test` section 13, on
  `fixtures/supports/simple_overhang.3mf`): at 35 the triangle pass flags the
  10, 20 and 30 deg steps only - 6 triangles, **259.06 mm^2 (+2.0 % on Bambu's
  254)**, z 37.74 - 46.47 - the same set as at 30. The card's areas: the arc's
  top (40 spots, z 38.0 - 46.3, every one on a 10 - 30 deg face) and two single
  side spots on ridges at z 17.7 (27.5 / 28.8 deg, off the arc; there at 30
  too). At the old 60: 7 triangles (half the 40 deg step joins), 301.88 mm^2,
  down to z 32.23; the grid's areas reach down the arc, 71 spots in 2 areas
  (70 + 1, the lowest at z 8.6) against 42. The rays down from the rest of the
  40 - 60 deg faces land on the model's 2 mm base, so the triangle pass counts them
  self-supported and the grid flags them as gap spots: the extra at 60 is 1.7x
  the spots, not 2x the triangle area.
- **What else moves at 35.** A 45 deg chamfer is no longer detected (section
  11's band keeps its explicit 60; section 13 holds that the band is left at
  35). The standing clamp: 262 spots in 4 areas (344 at 60) - area 1 loses the
  45 deg chamfer at z 62-71 and its 69 side tips, area 3 goes 27 -> 14 spots
  (docs/SUPPORT-INTERFACE.md section 4 table re-measured). The wedge: 326 spots
  in 10 areas (427 in 25). The top_clip_x2 coupon and top_clip_x2 detect the
  same at 35 as at 60, so `support:print-export`'s 3MF is unchanged.
- **Re-pinned.** `support:workflow` (default line, label and tooltip; the angle
  section now 25 -> 60 -> 95 -> back to 35; every "at 60" line to 35; the
  wedge 25 -> 10 areas, `WEDGE_HELD` 25 -> 10, its 25 areas / 427 spots at 60
  pinned as a comparison; the clamp's line regex). `support:test` section 12
  (coupon) at 35, section 13 new. `CARD.angleDeg` 60 -> 35 in
  `support:interface`, `support:shells`, `support:print-export`,
  `slicer:supports` - every one passes unchanged at 35 (131, 81, -, 26).
- `support:card` fails identically on the base (it drives the pre-detect-first
  card and is out of `testSteps`); not touched.
- `?v=`: `app-supports-card.js` print3 -> angle35, on the ticket's instruction.
  `testStepWeights` `support:test` 17000 -> 17500.

### export-bambu-project: NSO's 3MF is Bambu Studio's project envelope (2026-10-21, Phase 0 of the export/print plan)

Branched off `claude/supports-print-1` (#256, which changed `nso-3mf.js`);
PR against `claude-wip` once #256 is merged.

- **Template, not invention.** `fixtures/bambu-templates/a1mini-0.4/` holds
  the owner's `project_test.3mf` (Bambu Studio 02.08.02.61, unsliced) and
  `template.json` (printer, nozzle, `studio_version`, file, sha256).
  `nso-3mf.js` `build3MF` now writes that project's envelope part for part.
  Application is `BambuStudio-02.08.02.61`, the template's version, never
  newer: the compatibility shim, on record in docs/BAMBU-PROJECT-EXPORT.md.
  - Each piece is a `<components>` wrapper (object 2N) on
    `/3D/Objects/object_N.model` (object 2N-1, the mesh centred on its own
    origin); the build item places it.
  - UUIDs are Studio's counters with its fixed suffixes.
  - `project_settings.config` is the template's 581 keys, with NSO's 14
    cooling keys on every filament slot.
  - `model_settings.config` is in project shape: per-object overrides,
    `<part>`, the template's plate block, `identify_id` per instance,
    `<assemble>`.
  - The thumbnails, `slice_info`, `filament_sequence`, `cut_information` and
    `plate_1.json` are written as the template has them.
  - `nso_profile.json` and `nso_scene.json` are kept.
- **identify_id**: the object's own `identifyId`, else derived from its name
  and face count, so it is stable across exports and moves. Collisions step
  to the next free id. (It does not close GRISPR limitation 4: see the next entry.)
- **Support set** (`NSO_SupportInterface.SHEET.slicerSettings`):
  `wall_generator classic`, `detect_thin_wall 1`, `top_shell_layers 0`,
  `bottom_shell_layers 0`. Nothing else; per-family tuning waits for a print.
- **Fallback**: no template (file://, no fetch, a refused template) writes the
  old geometry-only envelope and says so (`envelope: 'nso'`,
  `templateError`).
- **Gates**:
  - `export:bambu` is new: part for part against the template, plus the
    version guard on a known-bad copy.
  - `3mf:roundtrip`, `3mf:drive`, `3mf:scene` and `export:roundtrip` read the
    new envelope.
  - `support:test` checks the four-key set.
  - `?v=bambu1` on `nso-3mf.js` and `nso_support_interface.js`.
- **The real gate is the owner's, in Studio**: File > Open, with no
  geometry-only warning; the override badge on supports; Cooling showing NSO's
  values; then slice.

### export-bambu-project, after the owner's first open (2026-10-21)

The owner's report:
- **What held.** The export loaded clean, as a project, and the four
  overrides held. The G-code shows the support's layer 1 as wall plus sparse
  infill (no bottom surface), and the four sheet layers as about 405 mm of
  outer wall each.
- **Cooling was dropped.** Studio showed Generic PLA's own 0 s / 8 s, and
  the slice used them, because each filament slot's
  `different_settings_to_system` entry was empty. Studio loads a slot with an
  empty entry as the system preset itself. `nso-3mf.js` now names the keys
  NSO changes in each slot's entry, `export:bambu` gates it, and the tag is
  `?v=bambu2`. Needs a re-open.
- **`identify_id` does not reach the G-code.** NSO wrote 1098 / 8388; the
  labels were 96 / 107, Studio's runtime ids. GRISPR limitation 4 stays open.
  The sliced file's `slice_info.config` pairs each label with the object's
  name.
- **To watch:** `bottom_shell_layers 0` makes the 0.2 mm foot pads a 15 %
  lattice, not solid.

docs/BAMBU-PROJECT-EXPORT.md has the details.

### export-bambu-project: the shell overrides failed on the print (2026-10-21)

- **The print failed from layer 1.** Under `bottom_shell_layers 0` the foot
  pads printed as an outline and a 15 % lattice. On layer 2, only 18.5 % of
  the support's extrusion lies over a layer-1 line, so the trunks started in
  mid-air.
- **The set is back to two.** The owner chose to return to the two
  overrides of the earlier successful print: `wall_generator classic`,
  `detect_thin_wall 1`. `top_shell_layers` / `bottom_shell_layers` are
  dropped.
- **Tags:** `nso_support_interface.js?v=bambu2`. `support:test`,
  `export:bambu` and `export:roundtrip` check the two-key set.

### export-bambu-project: the owner's Studio gate holds (2026-10-21)

The owner opened the v3 export (cooling fix, two-key support set) in Bambu
Studio 02.08.02.61 and confirmed every setting: it loads as a project, the
support carries its two overrides, and Cooling shows NSO's values. The PR
opens against `claude-wip` once #256 merges.

### export-bambu-project: rebased onto claude-wip 6f3354f (batch 19, #256 merged)

The four commits of this branch now sit on `claude-wip` 6f3354f.
- **Conflicts:** two, both append-only. `package.json` gets the
  `export:bambu` weight note beside #259's; `HANDOFF.md` keeps both appends.
- **Tags:** `nso-3mf.js` and `nso_support_interface.js` are `?v=bambu3`.

### gcode3mf-packager: a G-code string in, a Bambu .gcode.3mf out (2026-10-22, Phase 2a of the export/print plan)

Written on `claude/export-bambu-project` (#264, which changed `nso-3mf.js`),
then moved onto `claude-wip` a4ae142 once #264 merged. The one conflict was
`package.json`'s weights note (#263's `support:test` change): `claude-wip`'s line
is kept, with the `gcode3mf:test` clause added.

- **`nso-gcode3mf-write.js`** (`NSO_Gcode3mf`, browser + Node) writes the
  reference `.gcode.3mf`'s 17 parts in its order, from a G-code string plus
  the plate's metadata. The ZIP writer and CRC32 are imported from
  `nso-3mf.js`; reading back uses `nso-3mf-read.js`. MD5 is implemented in
  the file (`crypto.subtle` has none). No UI: `index.html` does not load it,
  so it has no `?v=`.
- **The G-code first.** Its HEADER_BLOCK, CONFIG_BLOCK and body give the
  layers, time, weight, label ids, max_z, nozzle, filaments, bed, layer-1
  footprints, filament changes and pauses; passed values only fill gaps.
  `describe()` reports each field's source.
- **Placeholders**, each pinned by the gate (docs/GCODE3MF-PACKAGER.md):
  blank transparent thumbnails, `first_layer_time` 0, no `<warning>` lines,
  `plate_1.json` ids = label ids and area = bbox area, `DesignerUserId`
  empty.
- **Gate:** `gcode3mf:test` (new, weight 3200) re-packages the reference:
  nine parts byte-identical, `3dmodel.model` and `slice_info` identical but
  the placeholders, footprints within 0.15 mm (0.01 worst), round trip
  through `read()` and through G-scope's import (the same 26 233 moves).
- **The real gate is the owner's:** print a re-packaged file on the A1 mini.
