# NSO vs Bambu Studio: printer / filament / process settings audit

Read-only audit of `/home/claude/nest-optimizer` (2026-11-28). Nothing in the repo was changed.

**How it was checked.** Code read: `nso-print-planner.js` (`settingsFrom` l.151, `engineOptions` l.286, `featureSpeed` l.367, `planTravels` l.717, `coolLayer` l.765, `fanFor` l.787, layer loop l.2590-2880), `app-print.js` (`PROFILES` l.82, `EXTRA_ROWS` l.173, `FILAMENTS` l.246, `configOverlay` l.574, `plannerExtras` l.793), `nso_slicer.js` (`defaultsFor` l.253), `nso-cooling-profiles.js`, both `frozen.json`.
Measured: the Simple Overhang arc (`fixtures/supports/simple_overhang.3mf`) was sliced and planned headlessly with the untouched A1 mini and P1S templates (no supports) and compared with Studio's own G-code: `simple_overhang_bambu.gcode.3mf` and `top_clip_x2_supports.gcode.3mf` (A1 mini, Generic PLA), `mouse1.gcode.3mf` (P1S, Bambu PLA Basic). The Studio arc slice has Studio tree supports, so move counts are not like for like; values per feature are.
Scratch outputs: `/tmp/claude-0/-home-claude/bda276fa-4d00-5d03-85d6-68a03f19b0f4/scratchpad/out/nso_a1mini_arc.gcode`, `.../out/nso_p1s_arc.gcode`, scripts in `.../scratchpad/scripts/`.

**Headline.** The command vocabulary of the print body is the same as Studio's except three things Studio writes and NSO does not: arc moves (`G2`/`G3` with E), `; Slow Down Start/End` stretches, and bare `G1 X Y Z` sloped moves (NSO writes them with an F). Machine limits, `M900`, `G29.1` and the start/end fans are identical because the start block is Studio's own text. No Studio fixture writes `M205` or `M900` in the print body. The real gaps are in cooling values, overhang grading, first-layer geometry and a handful of unread keys.

## 1. Settings table

"Card" = a row on the Print card. "frozen" = Studio's expanded text in `fixtures/print-planner/<printer>/frozen.json`, not computed by NSO. Fixture values are A1 mini template / P1S template.

### Printer

| Key(s) | What it does | NSO honours | Card |
|---|---|---|---|
| `machine_max_acceleration_*`, `machine_max_speed_*`, `machine_max_jerk_*` (M201/M203/M204 P R T/M205 at start) | firmware limits | yes, frozen literal lines; identical to Studio's in both printers. Only `machine_max_jerk_x` is read (time estimate, `settingsFrom` l.260) | no |
| `machine_start_gcode`, `machine_end_gcode` | start / end routine | yes, frozen with tokens for temps, bed, first-layer box, flush speed/temp, filament type, max Z | no |
| `layer_change_gcode`, `time_lapse_gcode` | per-layer hooks | yes, frozen variants (`hookLines` l.1901); A1 mini after first walls, P1S at layer change | no (hooks can be dropped per profile in code) |
| `change_filament_gcode`, `filament_flush_*`, `flush_volumes_matrix`, `flush_multiplier`, `filament_prime_volume`, long retraction when cut | filament change, purge | yes for multi-colour (`multiColour` l.972, `primeTower` l.1200); not audited in depth here | no |
| `machine_pause_gcode` | pause | yes (Pause at row, l.2297) | yes (Pause at) |
| `retraction_length`, `retraction_speed`, `deretraction_speed`, `retract_restart_extra` | retraction | yes (`settingsFrom` l.167-222) | length, speed (one row sets both speeds) |
| `retraction_minimum_travel`, `retract_when_changing_layer` | when to retract | yes (`planTravels` l.727; l.2591) | no |
| `wipe`, `wipe_distance`, `retract_before_wipe`, `wipe_speed`, `role_base_wipe_speed` | wipe while retracting | yes (95 % during wipe, 5 % after, as Studio's 0.76 + 0.04); `role_base_wipe_speed` not read, wipe runs at the path's speed, which is what Studio's files show | retract before wipe only |
| `z_hop`, `z_hop_types` (Auto Lift) | lift on travel | partly: hop height yes; type not read. NSO writes a spiral at layer change / hook and a sloped travel elsewhere, which matches the Auto Lift fixtures | z hop |
| `retract_lift_above`, `retract_lift_below` (0 / 179, 249) | no hop outside a Z band | no (not read anywhere) | no |
| `nozzle_diameter`, nozzle presets | nozzle | yes (`nso-bambu-presets.js`: diameter, layer limits, retraction length, min travel) | yes |
| `nozzle_type`, `required_nozzle_HRC`, `nozzle_volume` | hardness check, purge volumes | no (Studio-side warnings; `nozzle_volume` not read) | no |
| `printer_structure` (i3 / corexy) | timelapse placement, hop style | partly: hard-coded per printer id (`HOOK_AT_LAYER_START`, `REMAINING` l.104-106), key not read | no |
| `printable_area`, `printable_height` | bed size | yes (plan refuses off-bed / too tall; `Pr.bed`) | printer choice |
| `bed_exclude_area` (P1S 18x28 corner) | keep-out zone | partly: read only for the multi-colour travel points (l.1085); no refusal of a part placed there (not verified in the page's placement code) | no |
| `best_object_pos`, `extruder_clearance_*` | auto-arrange, by-object printing | no (by-layer only) | no |
| `curr_bed_type` + `G29.1` Z offset | plate type, textured-plate Z trim | partly: picks the bed-temperature key (`settingsFrom` l.159) and `plate_N.json` bed type; the `G29.1 Z-0.02` (A1 mini) / `Z-0.04` (P1S) line is frozen for Textured PEI | no (no plate-type row) |
| `auxiliary_fan` (0 / 1) | printer has an aux fan | yes (`auxFanFor` l.3045, `M106 P2`) | no |
| `scan_first_layer`, `timelapse_type`, clog / spaghetti hooks | printer-side checks | frozen hooks as Studio wrote them; `scan_first_layer` not read (not verified whether it changes G-code) | no |
| `default_acceleration` (6000 / 10000) and per-feature `*_acceleration`, `initial_layer_acceleration`, `travel_acceleration`, `initial_layer_travel_acceleration`, `travel_short_distance_acceleration` | `M204` per feature | yes (`settingsFrom` l.203-217); measured values equal Studio's (5000 outer, 2000 top, 500 first layer, 250 short travel) | no |
| `default_jerk`, `outer_wall_jerk`, `inner_wall_jerk`, `infill_jerk`, `top_surface_jerk`, `initial_layer_jerk`, `travel_jerk` | `M205` per feature | no. `default_jerk = 0` in both templates and no Studio fixture has an `M205` in the body, so nothing differs today | no |
| `accel_to_decel_*`, `silent_mode` | firmware tuning | no (off in both templates) | no |

### Filament

| Key(s) | What it does | NSO honours | Card |
|---|---|---|---|
| `enable_pressure_advance` (0), `pressure_advance` (0.02) | `M900 K` for the filament | no. Off in every fixture; the only `M900` is the frozen A1 mini start's `M900 K0.0 L1000.0 M1.0`. What Studio writes when it is on: not verified (no fixture) | no |
| `filament_flow_ratio` (0.98; PETG 0.95; TPU 1) | E multiplier | yes (l.2869) | yes |
| `print_flow_ratio`, `initial_layer_flow_ratio`, `top_solid_infill_flow_ratio` (all 1) | extra E multipliers | no (not read; all 1 today) | no |
| `filament_max_volumetric_speed` (12 / 21) | caps every speed | yes (`v = min(feature, limit / bead area)`); measured F9547 / F8843 / F15476 equal Studio's | yes (Max flow) |
| `filament_adaptive_volumetric_speed`, `volumetric_speed_coefficients` | flow-dependent cap | no (0 in fixtures) | no |
| `filament_retraction_length`, `_retraction_speed`, `_deretraction_speed`, `filament_z_hop`, `filament_wipe`, `filament_wipe_distance`, `filament_retract_before_wipe`, `filament_retraction_minimum_travel` | filament overrides of the printer's retraction | yes (`own()` l.171-231) | length, speed, before-wipe, z hop |
| `filament_retract_restart_extra`, `filament_retract_when_changing_layer`, `filament_z_hop_types` | more overrides | no (printer's value used; all `nil` in fixtures) | no |
| `nozzle_temperature`, `nozzle_temperature_initial_layer` | nozzle temps | yes (start tokens `{N}` `{T}`; `M104` at layer 2, l.2689) | yes |
| `nozzle_temperature_range_low/high` | allowed range, flush temp | yes (refuses temp steps / bridge temp outside it; flush temp fallback l.242) | shown as limits |
| `<plate>_temp`, `<plate>_temp_initial_layer` | bed temps | yes for the current plate type (`M140` at layer 2, l.2691) | bed (one value for both layers) |
| `chamber_temperatures` (0) | chamber target | no (0 in fixtures; no `M141`/`M191` in any Studio file) | no |
| `fan_min_speed`, `fan_max_speed`, `fan_cooling_layer_time`, `slow_down_layer_time`, `slow_down_min_speed`, `slow_down_for_layer_cooling`, `cooling_slowdown_logic`, `reduce_fan_stop_start_freq` | part fan by layer time, layer slowdown | yes as a mechanism (`fanFor`, `coolLayer`), but **the values are NSO's cooling profile, not the template's** (see section 4) | no (filament entry only) |
| `close_fan_the_first_x_layers` | fan off for first layers | yes (from the config, l.255) | no |
| `full_fan_speed_layer`, `first_x_layer_fan_speed` (0) | fan ramp over layers | no (0 in fixtures) | no |
| `enable_overhang_bridge_fan`, `overhang_fan_speed` | fan on bridges / overhangs | partly: only on `Bridge` and `Overhang wall` paths (l.2856) | no |
| `overhang_fan_threshold` (50 %; PETG 10 %; TPU 95 %) | from which overhang degree the fan rises | no (stored in the config; planner never reads it) | no |
| `overhang_threshold_participating_cooling` (95 %), `no_slow_down_for_cooling_on_outwalls` | which paths the layer slowdown may touch | no (NSO keeps bridges and spanning walls only, `it.keep`) | no |
| `pre_start_fan_time` | start the fan early | no (written to CONFIG_BLOCK only) | no |
| `additional_cooling_fan_speed`, `close_additional_fan_first_x_layers` | aux fan (`M106 P2`) | yes on a printer with `auxiliary_fan` (P1S: `M106 P2 S178`, same as Studio) | no |
| `activate_air_filtration`, `during_print_exhaust_fan_speed`, `complete_print_exhaust_fan_speed` | chamber exhaust (`M106 P3`) | partly: read only as variables of the filament-change template (l.1029); off in fixtures. The `M106 P3` lines present come from the filament start G-code | no |
| `filament_start_gcode` | chamber fan by bed temp, etc. | yes: frozen for PLA, a function per filament entry (`TPU_START`, `PETG_START`) | no |
| `filament_end_gcode` | end of filament use | yes in filament changes (l.1019); single filament: part of the frozen end | no |
| `filament_type`, `filament_ids`, `filament_vendor`, `filament_settings_id` | what the printer / AMS is told | yes (start token `{FTYPE}`, `slice_info.config`) | via Filament |
| `filament_density`, `filament_cost`, `filament_diameter` | grams, cost, E | yes (diameter in E; density for grams) | no |
| `filament_shrink` (100 %) | XY scale compensation | no (100 % in fixtures) | no |
| `filament_soluble`, `filament_is_support` | support material rules | no | no |
| `temperature_vitrification` | Studio's bed/chamber warnings | stored only | no |
| `filament_scarf_*` | scarf seam per filament | no | no |
| `filament_overhang_*_speed`, `filament_bridge_speed`, `override_process_overhang_speed` (0) | filament overrides of overhang speeds | no (override off in fixtures) | no |

### Process

| Key(s) | What it does | NSO honours | Card |
|---|---|---|---|
| `outer_wall_speed`, `inner_wall_speed`, `sparse_infill_speed`, `internal_solid_infill_speed`, `top_surface_speed`, `gap_infill_speed`, `support_speed`, `support_interface_speed`, `travel_speed` | feature speeds | yes (`featureSpeed`) | via Quality preset only; no rows |
| `initial_layer_speed`, `initial_layer_infill_speed`, `initial_layer_travel_speed` | first layer | yes | no |
| `bridge_speed`, `bridge_flow`, `thick_bridges`, `thick_internal_bridges`, `bridge_angle` | bridges | yes (`beadOf` l.405) | speed, flow |
| `enable_overhang_speed`, `overhang_1_4..4_4_speed`, `overhang_totally_speed` | wall speed by overhang degree | partly: a wall is `Overhang wall` only when its whole width hangs (`overhangEdgeFrac: 1`), then prints at the 4/4 speed (10) or, if it spans, the bridge speed (50). No 25 / 50 / 75 % bands (see section 4) | hang speed |
| `vertical_shell_speed` (80 %), `detect_floating_vertical_shell` | Floating vertical shell speed | no: the engine emits no such feature; `featureSpeed` would give it the inner wall's speed. Studio: F12000 (200 mm/s) on the P1S | no |
| `small_perimeter_speed`, `small_perimeter_threshold` (50 %, 0) | slow small loops | no (threshold 0 = off in both templates) | no |
| `smooth_speed_discontinuity_area`, `smooth_coefficient` (80 / 150), `; Slow Down Start/End` | speed ramps around slow stretches | no. Studio writes 2-3 marked stretches at F3000 per file; exact rule not verified | no |
| `layer_height`, `initial_layer_print_height` | layers | yes | layer (first layer is the profile's) |
| adaptive / variable layer height | per-layer heights | no (uniform; supports can have their own grid) | no |
| `line_width` and the eight `*_line_width` keys | bead widths | yes (`engineOptions` l.292-300), one gap on the A1 mini's first-layer infill (section 4) | yes (nine rows) |
| `wall_loops`, `top/bottom_shell_layers`, `top/bottom_shell_thickness`, `sparse_infill_density/pattern`, surface patterns and densities, `infill_direction` | shells and infill | yes | yes |
| `infill_wall_overlap` (15 %), `minimum_sparse_infill_area` (15), `sparse_infill_anchor_max` (20), `resolution` (0.012), `slice_closing_radius` (0.049), `top_one_wall_type` | geometry constants | partly: the engine has them as fixed defaults equal to Bambu's (`BAMBU_PROFILE_06`, `defaultsFor`); `engineOptions` does not pass the config's value, so a project that changes one is ignored. `sparse_infill_anchor` (400 %) not found | no |
| `elefant_foot_compensation` (0 / **0.15** on the P1S) | shrinks the first layer's outline | no (no occurrence in any source) | no |
| `xy_hole_compensation`, `xy_contour_compensation` (0) | XY size trims | no | no |
| `seam_position` (aligned), `seam_gap` (15 %) | seam | partly: aligned only (`seamAligned`), `seam_gap` yes (l.230); nearest / back / random not offered | no |
| `seam_slope_*`, scarf keys (`none`) | scarf seam | no | no |
| `enable_arc_fitting` (1) | `G2`/`G3` for curves | no: `G1` only | no |
| `precise_outer_wall`, `wall_sequence` (inner/outer), `is_infill_first` (0) | wall order | not read; NSO's fixed order is inner then outer then fill, which equals the templates' values | no |
| `wall_generator` + Arachne keys, `detect_thin_wall` | walls | yes | yes |
| `ironing_*` (no ironing) | ironing | no | no |
| `reduce_crossing_wall`, `max_travel_detour_distance` (0) | avoid crossing walls | no (off in templates) | no |
| `reduce_infill_retraction` | no retraction inside sparse infill | yes (`travelInside` on the layer's sparse region) | no |
| `brim_type`, `brim_width`, `brim_object_gap` | brim | partly: outer / none yes; **auto uses NSO's own rule** (height over root of foot area >= 2, 5 mm), not Studio's (section 4) | brim |
| `skirt_loops`, `skirt_distance`, `skirt_height`, `draft_shield` | skirt | no | no |
| `raft_*`, `support_*`, `tree_support_*` | raft and supports | yes, extensively (outside this audit's scope) | yes |
| `fuzzy_skin`, `spiral_mode`, `interlocking_*`, `enable_circle_compensation` | special modes | no | no |
| `print_sequence` (by layer) | object order | by layer only | no |

## 2. Bring over next (ranked)

1. **PLA cooling from the printer's own filament profile.** With "Profile (PLA)" the planner uses `nso-cooling-profiles.js` defaults (Bambu PLA Basic @BBL A1M: fan 60-80 %, slow below 6 s) on both printers. Studio's P1S slice runs the fan at 100 % all print and slows only below 4 s; the A1 mini template's Generic PLA slows below 8 s. This is the largest measured difference on the P1S. Where: `app-print.js` `plannerExtras` (cooling is `undefined` for `profile`) / planner `settingsFrom`. Size: small.
2. **Graded overhang speeds and the overhang fan threshold.** Studio prints partly hanging walls at 30 mm/s (and 50 / 10) with the fan at `overhang_fan_speed`; NSO prints them at full wall speed with the layer fan unless the whole bead hangs. For PETG (threshold 10 %) the gap is wider. Where: engine (grade each wall piece by overlap with the layer below) plus planner (speed band, fan by `overhang_fan_threshold`). Size: large.
3. **Elephant-foot compensation on the P1S (0.15 mm).** Studio pulls the first layer's outline in; NSO does not, so the first layer is about 0.15 mm fatter per side than Studio's on the same part. Where: engine, first layer's section offset. Size: small to medium.
4. **A1 mini first-layer infill width.** The A1 mini template (Studio 02.08) has no `initial_layer_infill_line_width`, so NSO lays the first layer's fill at 0.42 where Studio lays 0.50. Where: planner `engineOptions` (fall back to `initial_layer_line_width`), or refresh the A1 mini template from a Studio 02.09 project. Size: small.
5. **Arc fitting (`G2`/`G3`).** Studio fits arcs; NSO sends curves as short `G1` segments. `app-print.js` l.318-320 already records the consequence the owner measured: a 160-segment ring is held to about 229 mm/s by the 9 mm/s corner jerk. Where: planner, a fitting pass over each path before writing. Size: medium to large.
6. **Auto brim rule.** NSO put a 5 mm brim on the arc on both printers where Studio's `auto_brim` put none. Where: engine (`brimAutoRatio`). Studio's own rule was not read for this audit. Size: medium.
7. **Refresh the A1 mini template to the owner's current Studio setup.** The owner's Studio 02.09 A1 mini slices use first-layer speeds 40 / 90 (their process edit, also in the P1S template); the NSO A1 mini template still has 50 / 105. Where: `fixtures/bambu-templates/a1mini-0.4/` plus a re-freeze check. Size: small.
8. **Plate type.** The bed temperature follows `curr_bed_type`, but there is no row for it and `G29.1 Z-0.02` / `Z-0.04` is frozen for Textured PEI. Only matters if a smooth plate is used. Where: frozen-block token (`{curr_bed_type}` branch read off `machine_start_gcode`) plus a card row. Size: medium.
9. **Slowdown participation keys** (`overhang_threshold_participating_cooling`, `no_slow_down_for_cooling_on_outwalls`) and **`retract_lift_below/above`**. Small behavioural edges; the second only above Z 179 / 249. Where: planner. Size: small each.
10. **Pressure advance (`enable_pressure_advance`, `pressure_advance`).** Off in every profile the owner has sliced with, so nothing differs today. If a per-filament K is wanted, slice one file in Studio with it on, to see the exact line and where it goes, then add it to the filament start. Where: planner `withFilamentStart` / `FILAMENTS.start`. Size: small once a reference exists.

Not ranked because they are off in both templates: jerk per feature, small-perimeter speed, ironing, scarf seams, avoid-crossing-walls, skirt, XY compensation, chamber temperature, air filtration.

## 3. What NSO ships

**Printer profiles** (`app-print.js` `PROFILES`, l.82):

| Plate id | Profile id | Template | Frozen blocks | Studio version, preset |
|---|---|---|---|---|
| `a1mini` | `a1mini-0.4` | `fixtures/bambu-templates/a1mini-0.4/project_test.3mf` | `fixtures/print-planner/a1mini-0.4/frozen.json` | 02.08.02.61; 0.20mm Standard @BBL A1M, Generic PLA @BBL A1M, Textured PEI |
| `p1s` | `p1s-0.4` | `fixtures/bambu-templates/p1s-0.4/project_test.3mf` | `fixtures/print-planner/p1s-0.4/frozen.json` | 02.09.01.70; 0.20mm Standard @BBL X1C, Bambu PLA Basic @BBL P1S 0.4 nozzle, Textured PEI |

Nozzles and qualities come from `nso-bambu-presets.js` (Studio 02.09.01.70, regenerated by `tools/nso_bambu_presets_make.py`): A1 mini 0.2 / 0.4 / 0.6 / 0.8 with 29 quality presets; P1S 0.2 / 0.4 / 0.6 with 24. A nozzle preset carries only `nozzle_diameter`, layer limits, `retraction_length`, `retraction_minimum_travel`, `printer_settings_id`. A quality preset carries layer height, line widths, speeds, walls and shells. No other printer has a profile.

**Filaments** (`app-print.js` `FILAMENTS`, l.246; the `<option>`s are in `index.html` l.203-204):

| id | Label | Notes |
|---|---|---|
| `profile` | Profile (PLA) | the template's own filament; no keys, NSO default cooling |
| `cr-tpu` | Creality CR-TPU 95A | Generic TPU keys; A1 mini 215 C (first 235), 3.2 mm^3/s, bed 30; P1S 220 C, 3 mm^3/s, fan 40-65 %; external spool only; no wipe, no z hop; cool wait 8 s |
| `elegoo-petg` | ELEGOO PETG | Generic PETG keys; A1 mini 245 C, 10 mm^3/s; P1S 255 C, 16 mm^3/s; fan off 3 layers then 40-90 %; support top gap 0.33 |

**A new filament entry needs:**
- `id`, `label` (and `external: true` if it cannot go through the AMS), plus an `<option>` in `index.html` `#slice-set-filament`.
- `keys`: Studio filament keys written over every slot. Only keys the template already has are written. In practice: `filament_type`, `filament_ids`, `filament_vendor`, both nozzle temperatures, the range low/high, all five plate temperatures with their `_initial_layer` twins, `filament_max_volumetric_speed`, `filament_flow_ratio`, `filament_density`, `temperature_vitrification`, `filament_adhesiveness_category`, `filament_cost`, `close_fan_the_first_x_layers`, `additional_cooling_fan_speed`, `close_additional_fan_first_x_layers`, and any retraction overrides (`filament_retraction_length`, `filament_wipe`, `filament_z_hop`).
- `cooling`: its changes to the 14 cooling keys (object, or function of the config when the printers differ).
- `printerKeys(config)`: what differs per printer.
- `start(bed, config)`: its filament start G-code lines as Studio expands them (chamber fan by bed temperature).
- `studioId(config)`: the Studio preset name the file names.
- Optional `tune()` (bridge speed / flow / temp, cool wait, cool pillar, support top gap) and `slicer` (engine rules such as `shortFillMm`).
- For a 0.2 nozzle, a max-flow cap by `filament_type` in `nso-bambu-presets.js` `flow02` (has PLA, PETG, TPU).
- A check in `tools/print-slice-check.js` (section 5a holds each existing filament to an owner Studio slice), and a paragraph in `docs/FILAMENTS.md`.

## 4. Values NSO writes that differ from the Bambu fixture

| # | Setting | Bambu fixture | NSO | Where in NSO |
|---|---|---|---|---|
| 1 | P1S PLA part fan | `M106 S255` once, held all print (`fan_min_speed` = `fan_max_speed` = 100; `mouse1.gcode.3mf`) | layer fan `M106 S203.13` (about 80 %), 255 only on bridges / overhang walls (`nso_p1s_arc.gcode`) | `nso-cooling-profiles.js` `DEFAULT_VALUES` 60 / 80 |
| 2 | `slow_down_layer_time` | 8 s (A1 mini template, Generic PLA), 4 s (P1S template) | 6 s on both | same file |
| 3 | `fan_cooling_layer_time` on the P1S | 100 s | 80 s | same file |
| 4 | `pre_start_fan_time` in CONFIG_BLOCK | 0 | 2 (not acted on by the planner) | same file |
| 5 | First-layer fill width, A1 mini | `Bottom surface` LINE_WIDTH 0.50382 (arc), 0.50009 (coupon) | 0.42 | `engineOptions` l.300: key absent in the A1 template, falls to `line_width` |
| 6 | Auto brim on the arc | no `Brim` feature | `Brim`, 1200 moves, 0.5 mm line, both printers | `nso_slicer.js` `brimAutoRatio` |
| 7 | Partly hanging walls | `Outer wall` / `Inner wall` moves at F1800 (30 mm/s) and F600 with the fan at 255: 46 + 16 + 30 moves on the arc, 4 + 4 + 1 on the coupon | none: only `Overhang wall` at F600 / F3000 gets the fan | `featureSpeed` l.375, l.2856 |
| 8 | Fan on Studio's supports | `Support` moves run at `M106 S255` (over 5,000 moves on the arc) | planner raises the fan only for `Bridge` / `Overhang wall`. Not measured on an NSO support slice; Studio's rule not verified | l.2856 |
| 9 | Fan value rounding | whole per cent x 2.55: `S201.45`, `S204`, `S196.35`, `S193.8` | `S201.5`, `S195.49`, `S203.13` | `fanFor` l.796 |
| 10 | Curves | `G2`/`G3` with E: 5,213 (A1 arc), 7,356 (P1S mouse) | 0 | planner writes `G1` only |
| 11 | Internal solid infill width | varies 0.420-0.437 (spacing fitted to the region), top speed F9455 | fixed 0.42, F9547 | engine |
| 12 | Elephant foot, P1S | `elefant_foot_compensation = 0.15` in the template | not applied | no code |
| 13 | A1 mini first-layer speeds | owner's Studio 02.09 PETG slice: 40 / 90 mm/s (process edit) | template 50 / 105 | `fixtures/bambu-templates/a1mini-0.4/project_test.3mf` |
| 14 | Floating vertical shell | F12000 on the P1S (80 % of 250) | feature not produced; mapped to inner wall speed if it were | `featureSpeed` l.372 |
| 15 | Acceleration at the A1 mini layer-change hook moves (F18000 / F3000) | under `M204 S10000` | under `M204 S6000` | layer-change / hook sequence |
| 16 | `; Slow Down Start/End` | 3 stretches (A1 arc), 2 (P1S mouse), at F3000 | none | not implemented |

Values confirmed equal on the same settings: outer wall F9547.055, inner wall F8843.478, P1S F15476 / F12000 / F15000, first layer F3000 / F6300 (A1) and F2400 / F5400 (P1S), bridge F3000, all `M204` values, retraction 0.76 + 0.04 at F1800, deretraction 0.8 at F1800, z hop 0.4, spiral lift, travel F42000 / F30000, P1S aux fan `M106 P2 S178`, every machine-limit and start-block line.

Doc notes that are out of date against the code: `docs/PRINT-PLANNER.md` says the engine makes no `Gap infill` and has one infill width; both exist now (`gapFill`, the nine line-width rows).
