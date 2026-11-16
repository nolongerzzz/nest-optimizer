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
