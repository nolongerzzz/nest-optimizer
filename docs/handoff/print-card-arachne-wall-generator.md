## Print card - Arachne wall generator: Classic / Arachne and its six levers under Quality (2026-11-16)

Changed:
- `nso_slicer.js`: `arachneWalls`, `variableRuns`, `roomAt`, the seven options in `defaultsFor`, the layer loop.
- `nso-print-planner.js`: `engineOptions` reads `wall_generator` and the six Arachne keys.
- `app-print.js`: the seven settings and `wallRows`.
- `index.html`: the Quality rows.
- `styles.css`: `.slice-arachne-rows`.
- `app-supports-card.js`: `PRESET_FIELDS`, so saved settings keep them.
- Checks: `tools/nso_slicer_test.js` "Arachne" (12 checks) and `tools/print-slice-check.js` (10 more checks).
- Docs: `docs/SLICER.md` "Arachne" and `docs/PRINT-CARD.md`.

**What you get.** Quality → **Wall generator**: Classic or Arachne. With Arachne, six rows appear under it,
named and defaulted as in Studio:
- threshold angle 10°;
- filter margin 25 %;
- transition length 100 %;
- distribution count 1;
- minimum wall width 85 %;
- minimum feature size 25 %.

The walls of thin parts are then fitted to their thickness. A 0.3 mm rib prints as one 0.34 mm bead, where
Classic printed nothing. A 1.0 mm strip prints as three beads of 0.362, where Classic left one loop and a
0.58 mm gap.

**Unchanged.** Classic is the default and both profiles say classic, so a card with nothing touched slices
as before: `slicer:test` (180) and the 32-slice byte pin, plus `print:slice` (156). Under Arachne, a part
with nothing thin slices byte for byte as Classic. Supports stay Classic.

**Not yet.** No real Arachne slice to measure against. The rules are NSO's own (no AGPL code: Arachne
lives in CuraEngine and Studio), stated in docs/SLICER.md "Arachne".

**Measured (2026-11-19).** The owner's two real Studio slices of a plate of TPU anti-vibration feet (four 60 mm blocks):
- **Arachne, 2 walls:** every feature on every layer within 0.03 % of Bambu's, at Bambu's insets to 2 µm. Arachne is
  Classic on a thick part, as the engine said.
- **No walls, no shells, 3D honeycomb 10 %:** brought three fixes.
  - Wall loops 0 is no wall; the infill runs to half a line from the edge. The card's row now takes 0.
  - A shell thickness adds no layers to a count of 0.
  - The 3D honeycomb's wave height is a length: straight every 3.0 mm at 10 %, not every 14 layers. Every layer is now
    within 2.5 % and its lattice within 0.015 mm.

`fixtures/slicer-feet-reference.json` holds the measures, not the files (the model is its designer's), and
`tools/nso_slicer_feet_reference.js` remakes it from the two files. `slicer:test` 189, `print:slice` 174.
`gcode:gscope-slice` fails before and after this change: it reads the `ms-slice-*` rows G-scope no longer has.

**Shell rows (2026-11-19, after the owner's screenshots).** Studio sliced the feet as pure 3D honeycomb and the Print card
sliced them solid: the card had no shell rows, so the profile's 5 top / 3 bottom always printed. Strength now has Studio's four:
Top shell layers, Top shell thickness, Bottom shell layers, Bottom shell thickness (`top_shell_layers` ... keys; saved settings
keep them). With Wall loops 0, both shell layers 0, 3D honeycomb 10 %, four 60 mm feet on the real page come out 120 layers of
Sparse infill alone, 397 m against Studio's 393 m (+0.9 %), in G-scope's preview. `print:slice` 179 (+5).
