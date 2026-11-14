# Bambu's Advanced support rows - on the Supports card, in the slicer, in the file

Card: `index.html` `#sup-bambu-sec` (**Advanced**, under Tree settings). Settings: `app-print.js` (`SUP_ROWS`, `SETTINGS_DEFAULT`, `cleanSettings`,
`configOverlay`, `slicerOptions`). Slicer: `nso_slicer.js` (`defaultsFor`, `columnRule`, `columnType`, `buildLayers`). The tree's share:
`app-supports-card.js` (`BAMBU_TREE`, `bridgeNow`). Gates: `npm run slicer:support-levers`, `npm run support:advanced` (both in `testSteps`),
`npm run support:settings-drive` (the real page).

## 1. What it is

Bambu Studio's Advanced block of its Support tab, row for row and in its order. The owner prints from Studio and from NSO and was moving between levers
that were constants in three files; they are rows now, and **Saved settings** (docs/SUPPORTS-CARD.md 10) keeps them with the rest of the card.

**Each row starts at the printer profile's value** (docs/PRINT-CARD.md "Starting values", 2026-11-14; before that each started at what NSO did
before the row existed). A slice with no settings at all is given the same values, so a card left alone slices the same G-code, line for line
(`support:advanced` holds that). The old numbers are the built-in saved setting **NSO classic**: top Z 0.18, first layer solid, bridges to 5 mm.

They are Slice settings: the slicer reads them (`slicerOptions`), the exported file carries each changed one under Bambu's own key (`configOverlay`:
`project_settings.config` and the G-code's CONFIG_BLOCK), and Generate reads the four that shape the tree.

## 2. The rows

| row | Bambu's key | starts at | who reads it | what it does here |
|---|---|---|---|---|
| Initial layer density | `raft_first_layer_density` | the profile's (90 %) | slicer `supportFirstLayerDensity` | the fill of a support's first layer: its lines that much further apart |
| Initial layer expansion | `raft_first_layer_expansion` | -1 | Generate (`padGrowMm`) | how far the first-layer pad reaches past a trunk's foot; -1 automatic, 0.6 mm |
| Support wall loops | `tree_support_wall_count` | -1 | slicer `supportWallLoops` | walls round every piece of the tree; -1 or 0 automatic: one |
| Top Z distance | `support_top_z_distance` | the profile's (0.2) | slicer `supportGapMm` | the gap under the part |
| Bottom Z distance | `support_bottom_z_distance` | 0.2 | Generate (`bottomGapMm`), slicer `supportBottomGapMm` | the gap under a foot that stands on the part; the slicer holds the support's layers to it too |
| Base pattern | `support_base_pattern` | Default | slicer `supportBasePattern` | Default: walls and a line across each ring under a stack. Rectilinear / Rectilinear grid: lines through the whole tree, one way / both. Hollow: walls alone |
| Base pattern spacing | `support_base_pattern_spacing` | 2.5 | slicer `supportBaseSpacingMm` (and the raft's base) | the base pattern's lines that far apart |
| Pattern angle | `support_angle` | the profile's (0) | slicer `supportAngleDeg` | the base pattern's direction; with Interface angle on Profile, the stack's first layer a quarter turn on |
| Top interface layers | `support_interface_top_layers` | 3 | the support's own (`sup-interface`) | as before: 0 - 3 |
| Interface pattern | `support_interface_pattern` | Default (auto) | slicer `supportInterfacePattern` | Default: the Interface angle rule. Rectilinear: one way. Rectilinear Interlaced: a quarter turn a layer. Grid: both ways a layer, at twice the spacing. Concentric: rings |
| Top interface spacing | `support_interface_spacing` | the profile's (0.5) | slicer `supportInterfaceSpacingMm` | the gap between interface lines |
| Normal Support expansion | `support_expansion` | 0 | slicer `supportExpansionMm` | Bambu widens its normal supports by it; NSO builds trees, so it moves how far the interface reaches past an overhang's edge |
| Support/object xy distance | `support_object_xy_distance` | 0.35 | slicer `supportXyMm`, Generate (`xyMm`, a tenth more) | the support's distance from the part beside it |
| Z overrides X/Y | `top_z_overrides_xy_distance` | off | slicer `supportZOverridesXy` | on: where the part stands over a layer the support comes in to 0.2 mm of the wall beside it; the top distance decides |
| Support/object first layer gap | `support_object_first_layer_gap` | 0.2 | slicer `supportFirstLayerGapMm` | a support's first layer that far from the part's first layer |
| Max bridge length | `max_bridge_length` | the profile's (0) | the detector (`bridgeMm`) | a span this long or shorter is a bridge and gets no support; 0: every bridge is held. The outlines follow |
| Independent support layer height | `independent_support_layer_height` | on | slicer `supportLayerMaxMm` | off: the support is cut on the part's layers |

At their defaults the Bottom Z distance and the first layer gap are not handed to the slicer: the support's mesh keeps them as built (Generate carves the
foot; the pad stands 0.2 off the part), and a rule added on top could move a layer of a build that was right.

Base patterns Bambu has and this slicer does not lay in a support (Honeycomb, Lightning) are not offered.

## 3. In the slicer

- **Wall loops**: `buildLayers`' support walls take `supportWallLoops` (>= 1) for `CONSTANTS.supportWalls.loops`.
- **Base pattern**: `columnType`. Rectilinear lays lines through every piece of the tree's section on every layer at one angle, so each layer's lie on the
  last's; Default keeps the ring lines (a ring of 6 mm2 or less, under a stack of its own) at the spacing given.
- **Interface pattern**: `columnType`'s stack fill. The stack's first-layer angle (by the Interface angle rule) is the pattern's.
- **Bottom Z distance**: `columnRule` blocks a support layer over a top face of the part that is less than the distance under it.
- **Z overrides X/Y**: `columnRule` keeps the part's shadow over each plane; under it the side block is 0.2 mm (`COLUMN_Z_OVER_XY_MM`), not the xy distance -
  for the part beside the layer and for the part just over it.
- **First layer**: `buildLayers` spaces a support's first-layer fill by the density; the gap is cut from its first section, on the shared grid and on a
  support's own.
- **Expansion**: `columnRule`'s reach past an overhang's edge (0.38 mm) plus the row.

## 4. Saved settings and the Slice rows

The Slice rows are put back to the printer profile's values when the page opens, when the template arrives and when the printer changes. A saved setting the
card shows lays its own back over them each time (`window.nsoSliceRowsSeeded`), so it holds through a reload - the page drive found it did not. The Slice
section's Reset is the owner asking for the profile's: the card then shows no saved setting.

## 5. Not done

- G-scope's own Slice settings (`ms-slice-*`) do not have the rows.
- The Slice section's support threshold is still its own row, not the card's Angle.
- The print / prep card: these rows are Slice settings on the Supports card, which is where that card would take them from.
