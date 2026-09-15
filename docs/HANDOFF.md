# Handoff (Claude Code reads this. User does not paste code.)

Branch: `claude-wip` only. Never push `main`.

**PR #4 is closed and already on main** (corners1, 2026-09-08, squash `4ea5eca`).
Do not reopen it. Do not comment on it. Do not treat it as a drop box.
New work: commit on `claude-wip`. Open a **new** PR if a review surface is needed.
Grok merges `claude-wip` → `main` and owns HUD / `?v=` tags.

## Output protocol
1. Findings, numbers, diffs, and next-step proposals go in the current ticket PR
   (a new PR off `claude-wip`) or in the commit message. Never PR #4.
2. Chat carries a short status line. No full script dumps. No `app.js` token.
3. Never apply `stash@{0}` or any parked patch unless Grok or this file says **APPLY**.
4. Never bump `?v=` tags — Grok owns the HUD string (`stampHud()` in the UX script).
5. Pass/fail is math: `tools/stl_watertight_check.py --odd --degen` plus the
   geometry probes the current ticket names. Never call a mesh correct from a screenshot.

## Ping pong
A bare STL drop, no text, is the latest live export for the current ticket.

- Run the checker and the ticket probes.
- Commit or comment on the **current** ticket PR.
- Ticket fails → one scoped patch on `claude-wip`, then a short status line.
- Ticket passes every named gate → comment "this is correct" with the numbers, no further patch.
- A decision is needed → one question, then `I need your attention`.

## Current factory (do not rewrite from this file)
Live HUD is `inside4`. Finish wrap + paint + pocket bake is the open factory path.
CTH is gated (`?cth=1` / `?cth=finish` / `?cth=drive`) and removable.
Parked modules (repair, sculpt, planar fuse) stay unwired until the owner names a ticket.
Clean no-op mesh for repair checks is `fixtures/box-20mm.stl`, not Thingi10K 40921
(40921 has 17 bowtie vertices; edge-based checks miss that).

## 3MF export - baked cooling settings
`nso-cooling-profiles.js` + `nso-3mf.js`, wired into `app-core.js` (the
export-format block and the `export3MF` block) and `app-join.js` / `app-ux.js`
(the buttons and the right-click item). Full write-up:
`docs/baked-cooling-settings.md`.

Unlike repair / sculpt / planar fuse, this one **is** wired in. The entry point
is one **Format** selector (STL / 3MF) at the top of the Export card, remembered
in `localStorage` as `nso.exportFormat`. It drives **Download selected**,
**Export plate** and the right-click **Export** item alike, relabelling them; the
cooling-profile row only shows for 3MF. There is no separate 3MF button any more
(`#btn-export-3mf` is gone; the plate button keeps its `#btn-export-stl` id
because app-cut.js and app-core.js enable/disable it by that id). "Download
selected" with 3MF is `exportActiveModel3MF()`: the active model as a one-object
project, same axis swap and bad-triangle filter as `exportActiveModel()`, set
down centred on the current plate resting on z = 0, same filename prompt.

Landed on `main` via `claude/3mf-io` (PR #45), a scoped branch: the two
modules, the export wiring, the Format selector and the import, nothing else
from `claude-wip`.

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

## 3MF checks
`npm run 3mf:roundtrip` is the dependency-free suite (56 checks): it exports a
real `.3mf` and reads it back with an independent ZIP reader, asserting key set,
key order, array-of-string shape, byte-exact values including `%`, raw text
form, determinism, and that the format guard rejects bad values.
`npm run 3mf:drive` (63 checks) drives the real app in headless Chromium -
the Format selector (labels, cooling row, persistence across a reload), fixture
import, a clone so the plate carries two pieces, the actual **Export plate**
click with Format = 3MF, the actual **Download selected** click with Format =
3MF (filename prompt accepted), the plate click again with Format = STL - then
takes both saved 3MF files apart (14 keys, `%` rule, one object per piece / one
object for the selected model, on-plate coordinates) and sanity-checks the STL.
It deliberately does **not** press Optimize: `runOptimize()` throws on this
branch (it reads `#opt-orient` / `#opt-rotate`, neither of which is in
index.html - already true at 63c5b00). An earlier draft of the check did press
it and asserted `state.placed.length > 0`, which passed for the wrong reason,
since `handleFiles()` already places the imported piece. Both are in `npm test`. Like the CTH
browser checks, the drive serves three from devDependencies, not the CDN. On a
runner whose Chromium predates the installed Playwright, set `CHROME_PATH`.

## CTH checks
`npm run cth:unit` is the dependency-free suite (`tools/cth-test/*.test.mjs`,
also runnable as `./tools/cth-test/run-all.sh`). `npm run cth:capture` drives the
real app in headless Chromium and needs `npm ci`. `npm test` runs both. The
capture check serves three from the `three` devDependency rather than the CDN
`index.html` names, so it needs no network.

## Parked ticket - re-vendor cth/ from click-test
`cth/` is a vendored fork of `nolongerzzz/click-test` `src/`, and it has
drifted: 55-278 changed lines per file. Two regressions have already been
traced to the vendoring rather than to upstream - `escapeHtml` had its entity
map HTML-decoded, so only the apostrophe was escaped, and the overlay lost
upstream's always-a-list `renderAims()`. Both are fixed here now; the overlay's
completion-only summary is a deliberate divergence for the corner card, not
drift, and should stay.

Do NOT blanket-overwrite `cth/` from upstream. Some of the drift is intentional
nest-specific work. This needs a deliberate file-by-file review deciding, for
each hunk, whether it is a nest change to keep or vendoring damage to drop.

## Archive — Soften Corners second pass (corners2), historical

corners1 was measured on the exported STL of the live FAIL. What it actually
built, on the 12.38 x 20 x 20 baked half at R=2.5:

- All FOUR cap-loop corners carried an arc of exactly radius 2.5 (tangent at
  7.5 on each edge, centres at (+/-7.5, +/-7.5)). Watertight, 0 open, 0
  non-manifold. So "one pair only" is not in the mesh — but the shape was
  still wrong, in two ways that explain what it looked like:
- **Orbit-point.** The corner surface converged radially on the ORIGINAL
  sharp apex at depth 1.0355 — every rollover sample ran to one vertex, so
  the corner is a cone apex, not a fillet. From any camera off the face
  normal it reads as a point.
- **Bite too small.** corners1 rounded the lid boundary in plan with radius
  R but only cut the wall back by R/sin(45) - R = 0.4142 R. At R=2.5 that is
  a 1.04mm bite where 2.5mm was asked.

corners2 put Corners back through `rawEdgeRoundInPlace`. That work is already
on main as later corners tickets. Do not re-open it from this archive.

### Known, not current
`branch point in cap boundary` still refuses some cut faces (parked
`stash@{0}`) — Round, Bevel and Corners all refuse there identically.
`stash@{0}` stays parked until an explicit **APPLY**.

## Sculpt tier 1 — vertex adjacency + global smoothing (landed, `app-sculpt.js`)

Full write-up with numbers: `docs/SCULPT-TIER1.md`. Self-test:
`node tools/sculpt_selftest.js`. Script tag added to `index.html` at the
existing `?v=inside3` — tag NOT bumped.

State: both tiers built and measured. Topology invariance verified on every
fixture (same vertex count, triangle count, connectivity; only positions
move). Global Laplacian has no feature preservation and no way to protect a
region — that is the brush tier, and nothing in `app-sculpt.js` should grow
a feature term.

Three findings land on code this ticket did NOT touch. They matter for the
merge-order pass because each is someone else's gate:

1. `NSO_weldEpsFor` (app-join.js) caps the weld tolerance at the strict
   minimum edge, so a handful of slivers set the tolerance for a whole mesh.
   On the tape fixture 2 edges out of 98,586 drag it to 5e-6 and the part
   reads as 1402 open edges; it welds to V-E+F 2, 0 open at 3e-5.
   `NSO_sculptWeldTol` in app-sculpt.js carries the fix. Both booleans still
   run the old rule.
2. `NSO_edgeStats` and `rawCheckWatertightQuick` weld by coordinate
   rounding, so neither can see a backwards-wound face: it pairs every edge
   and reads 0 open while the volume is wrong. `NSO_buildAdjacency` counts
   directed edges (`stackedDirs`) and requires 0 for watertight. This is a
   second, distinct hole alongside the already-parked 208-odd-edge tolerance.
3. `tools/stl_watertight_check.py` rounds to 1e-5, too tight for a float32
   STL of an 82mm part: it reports 1406 false open edges on the tape fixture.

None of the three touched — each wants its own scoped pass and an APPLY.
