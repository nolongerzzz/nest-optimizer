## 3MF import - geometry only
`nso-3mf-read.js` (UMD, no deps, same code under Node and in the page), called
from `handleFiles()` in `app-core.js` for `.3mf`; `#file-input` now takes
`.stl,.3mf`. One model per build item, transforms applied, names from Bambu's
`model_settings.config` / `<object name>` / the file name. The STL and 3MF
branches share `addModelFromZUpGeometry()`, so an imported 3MF object has
`rawTris` in file axes exactly like an STL and Cut / Sculpt / both exporters
treat it the same. Full write-up, including what is out of scope (settings,
paint, multi-plate, `.gcode.3mf` without a model part): the "3MF import"
section of `docs/baked-cooling-settings.md`.

Real-file evidence: Bambu Studio's own calibration files (`fixtures/3mf/`,
AGPL, two different layouts incl. ZIP64 and the Production extension) and a
MakerWorld project saved by BambuStudio-02.07.01.62 (not committed; run it with
`NSO_3MF_REAL=...`). Every object read back passes
`tools/stl_watertight_check.py --odd --degen` and has positive signed volume.

`npm run 3mf:import` (55 checks, +8 with `NSO_3MF_REAL`) and
`npm run 3mf:import-drive` (21 checks, real app in headless Chromium: the two
fixtures in, an imported object out through both export routes, NSO's own
export re-imported corner for corner, a junk `.3mf` reported not thrown). Both
in `npm test`.

Two things must not be "tidied up", both confirmed against a real Bambu export
(stock Bambu PLA Basic @BBL A1M):
- every value is a single-element array of strings, `["50%"]`, never a scalar;
- percent fields keep the literal `%`, plain numeric fields do not, even where
  the number is semantically a percentage (`overhang_fan_speed` is `"100"`,
  `fan_max_speed` is `"80"`). Bambu's own inconsistency. `KEY_FORMATS` in
  `nso-cooling-profiles.js` pins this per key and `validateValues()` runs on
  every export, so a tuned profile cannot silently add or drop a `%`.

`DEFAULT_VALUES` is the confirmed stock set and is frozen. Tuned profiles are
`overrides` layered on top of it - `breakaway-support`, `fine-detail` and
`high-flow` are reserved and untuned, and export identical to `default` until
someone fills them in. Adding a tuned profile means editing that one table and
nothing else.

`project_settings.config` carries only the 14 confirmed cooling keys. NSO's own
bookkeeping lives in `Metadata/nso_profile.json` instead, because Bambu warns on
keys it does not recognise.

Known limitation, confirmed by testing and **documented rather than solved**:
swapping filament presets in Bambu Studio after opening an export raises "Use
Modified Value of Filament Preset", and "Discard Modified Value" drops the baked
settings silently. Inherent to how Bambu reconciles a project against a preset.

Settled: the container is JSON with `:`. The owner pulled the keys with
`json.load()`, which only parses valid JSON; the `key = ["value"]` form in the
ticket was shorthand. Serialization is correct as written.

Still open, and the one thing no check here can reach: **nobody has opened one of
these in a real Bambu Studio instance.** The doc carries a key -> Cooling tab
field table to check against, what does and does not count as coercion (the
speed fields are stored bare and rendered with a `%` - that is expected, not a
rewrite), and the likeliest failure mode if it fails at all: NSO writes only the
14 cooling keys and no preset-identity envelope. Record the outcome in the doc.

Out of scope here: the Grispr G-code post-processing path for multi-material.
