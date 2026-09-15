# Handoff (Claude Code reads this. User does not paste code.)

Branch: `claude-wip` only. Never push `main`.

**PR #4 is closed and already on main** (corners1, 2026-09-08, squash `4ea5eca`).
Do not reopen it. Do not comment on it. Do not treat it as a drop box.
New work: commit on `claude-wip`. Open a **new** PR if a review surface is needed.
Grok merges `claude-wip` → `main` and owns HUD / `?v=` tags.

## Standing rule — paint wins, for every bake
Owner's decision, and it binds new work as well as old: **a painted / excluded
face stays untouched by ANY bake mechanism**, not only the one the paint system
shipped with. A new bake feature reads mask6's skip list and either leaves that
face exactly as it was or stands down and says which face stopped it. It never
assumes nothing is painted — take the skip list as a required input, not an
optional one with an unpainted default, because unpainted is the value a caller
gets by forgetting.

Read the list, never re-derive it. `app-mask.js` hands back the raw axis and
side each click recorded; working out which face was meant from a plane and a
bounding box is the second mapping that put the yellow on one face and the
exclude on another. `brickSkipLists(...).pocket` and `nsoMaskFaceList` are the
supported ways in.

### Scoping — which faces a feature checks (added 2026-09-15)
The rule is one rule; **how** a feature checks paint depends on its operating
shape. Before wiring paint-awareness into a new feature, answer one question:

> Does this feature act on a specific, identifiable sub-region of the piece, or
> does it modify the whole piece with no clean sub-region?

- **Whole-piece** — stand down entirely if ANY face on the piece is painted.
  There is no sub-region to scope the check to, so this is the only coherent
  reading. The test is `nsoMaskCount(m) > 0`.
- **Sub-region** — check only the feature's own relevant faces. Paint elsewhere
  on the piece (a different pocket, the outer hull) does not block it.

Both are correct applications of the same rule at different scopes, **not**
inconsistent exceptions — do not "fix" one to match the other. Every
paint-aware feature **must state its category explicitly in its own
documentation**, so the next ticket reads it instead of re-deriving it.

Current roster, by category:

| feature | category | paint test | stated in |
|---|---|---|---|
| Smooth (`app-sculpt.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Repair (`app-finish.js`, Seal's checkbox) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Fusion (`app-join.js`, Join Route 0) | whole-piece | `nsoMaskCount(A)+nsoMaskCount(B) > 0` | stand-down comment |
| Pocket corners (`nso_inside_corners.js`) | sub-region | this pocket's floor + 4 walls | `docs/INSIDE-CORNERS.md` §2 |

`node tools/nso_paint_scope_test.js` asserts every entry actually carries its
label in source, so a deleted or drifted declaration fails rather than rotting.

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
Live HUD is `inside3`. Finish wrap + paint + pocket bake is the open factory path.
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

`main` (the live site) has none of this yet - no 3MF modules, no Format
selector; that is a `claude-wip` -> `main` merge, Grok's call.

**3MF import is deliberately absent, and is a separate ticket.** `#file-input`
carries `accept=".stl"` and `handleFiles()` filters to `.stl` ("STL files only
for now"), which is why `.3mf` is greyed out in the picker. That is a guard, not
an oversight: the only loader on the page is THREE's `STLLoader`, and nothing in
the app reads a ZIP (`nso-3mf.js` is write-only; the only ZIP *reader* is the
Node one in `tools/3mf-test/roundtrip-check.js`). Dropping the filter would feed
a ZIP to `STLLoader.parse` and fail. A usable import needs a browser ZIP reader
(`DecompressionStream('deflate-raw')` plus a central-directory walk), the OPC
rels to find the model part, the 3MF core XML (objects, mesh, build items with
3x4 transforms, `<components>`), and for files Bambu Studio writes the
Production extension too (per-object `3D/Objects/*.model` parts referenced via
`p:path`), then a mapping into `addModel()`'s `rawTris` / `rawAxis` /
`centerOffset` record and a decision on multi-object files. Not started here.

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

Concrete, as of 2026-09-15: bare `npm test` **exits 1** in the web sandbox with
`browserType.launch: Executable doesn't exist at
/opt/pw-browsers/chromium_headless_shell-1243/...` — playwright wants 1243, the
box ships 1194. Not a code failure; the four dependency-free cth:unit files pass
first and the chain then stops at `cth:capture`. Run it as
`CHROME_PATH=/opt/pw-browsers/chromium npm test` (that path is a symlink to the
1194 binary), which exits 0 - re-confirmed 2026-09-15 after the Format-selector
change. `tools/nso_app_harness.js` (the wire-* suites) already resolves this
itself in `chromiumPath()` and needs no env var; `cth-test/browser-lib.mjs` and
`3mf-test/export-drive-check.mjs` read `CHROME_PATH` only.

## Grispr - per-object fan control (G-code post-process, NOT wired in)

`tools/grispr/grispr.py`, standalone Python 3, stdlib only. Full write-up:
`tools/grispr/README.md`. Suite: `npm run grispr:test` (82 tests, 16 synthetic
fixtures, plus 60 randomised layouts). Deliberately not in `npm test` - like
repair / sculpt / planar fuse it is unwired, and `npm test` is all-node today.

**NEXT CHECK - ANSWERED 2026-09-14, non-zero.** A real 2-object slice
(567,481 lines, 113 layers, objects 197 and 237) carries 336 balanced
`start/stop printing object` pairs, 113 layer manifests and 898 `M624`/`M625`
lines. The single-object file had none of those. So Bambu emits the labelling
machinery only for plates with more than one object, real multi-object plates
land in LABEL mode, and the inferred path only ever sees single-object files -
where per-object fan control is moot anyway. The write-refusal on multi-object
inferred files stays, as a guard against a shape that may not occur rather than
one expected to fire. Nothing had to be lifted: that refusal was always scoped
to `marker_mode == "object_id"`, so labelled multi-object writes were never
blocked.

Validated on that file: `--list` reads 336 blocks in label mode and flags true
interleave on essentially every layer. Targeting object 197 alone, object 237's
116 blocks spanning 389,156 lines show ZERO fan-state leaks, every one of the
567,482 original lines survives byte-identical and in order, and `--force`
reverts the 13.5 MB file byte-for-byte. First real-data proof of the no-leak
claim.

**It corrected a premise this module was built on.** The kickoff said fan state
is untouched at object transitions. It is not: 273 of that file's 335
transitions carry a fan command. Bambu wraps the layer-change/timelapse section
in `M106 S255` ... `M106 S<ambient>` with `M624`/`M625` masks around each block.
Those belong to the layer change, not to either object, so they sit between
blocks and Grispr leaves them alone - but they are one more thing overwriting a
forced value, which reinforces the --hold finding rather than softening it.

It is the advanced-mode companion to the baked cooling exporter, not an
alternative to it. The exporter owns the single-profile whole-plate case.
Grispr owns what the 3MF schema cannot express at all: per-object fan. It runs
as a Bambu Studio post-processing script (Others tab), so it depends on no
filament-preset state and cannot be dropped by "Discard Modified Value".

Two decisions that must not be "tidied up":

- **Boundary injection is the default.** Grispr injects at an object's start
  marker and restores at its stop marker, and leaves every `M106`/`M107` the
  slicer emitted INSIDE the object alone, because those include Bambu's native
  overhang/bridge forcing (`enable_overhang_bridge_fan`, already baked in by
  the exporter). `--hold` suppresses them and is opt-in precisely because it
  defeats that forcing. Do not make `--hold` the default.
- **The restore value is computed, never a constant.** At each stop marker it
  is the fan state the UNMODIFIED file would have had at that line. Objects
  interleave within a layer and an object can be re-entered on the same layer,
  so restoring to "the value before the block" would leak state into whoever
  prints next. Measured case, from the fixtures: object 2 raises the fan to
  S255 for an overhang mid-block, object 3 then prints on the same layer and
  correctly gets S255 back, not the S102 layer ambient.

Pass/fail is the leak invariant, not eyeballing injection points: for every
line outside a targeted object's block, the fan state in the output must equal
the original file's state at that same line. Checked line by line, every
fixture, every target combination, with and without `--hold`.

### Flagged at the 3MF exporter: `identify_id` is not written

`buildModelSettings()` in `nso-3mf.js` writes `<object id="N">`, a `name`
metadata, and a `model_instance` carrying `object_id`. It does not write
`identify_id`. `grep -rn identify_id` over this repo hits only this entry and
Grispr's own docs - no code writes it.

Grispr targets the G-code `unique label id`, which is Bambu's `identify_id` for
that object. So NSO controls the object ORDER it writes into the 3MF, not the
id Bambu stamps into the sliced G-code, and the chain

    NSO internal object -> 3MF identify_id -> G-code unique label id

is open at the first link. This does not block using Grispr - ids come from the
command line, read off `--list` - but it does block automating the hand-off.

Two ways to close it, exporter's call:

1. Write `identify_id` explicitly in `buildModelSettings()`. Only works if
   Bambu honours an incoming value on load instead of reassigning it.
2. Confirm empirically that Bambu's assignment is predictable from load order,
   then pin that as a documented assumption with a check behind it.

Either is a change to the exporter, not to Grispr, and neither has been tested.
The same real-Bambu-Studio session that verifies the baked cooling values can
settle it in one pass: export a 3-object plate, open it, slice it, and read the
`; start printing object, unique label id:` values back against the object
order NSO wrote.

### Real file, run 2026-09-14 - three defects found, all fixed

107,548 lines, 105 layers, one object (`; OBJECT_ID: 518`), stock Bambu PLA
Basic. Findings, in order of how much they mattered:

1. **The file has no start/stop object markers at all.** 105 `; OBJECT_ID: 518`
   comments, zero `start printing object` / `stop printing object`, zero
   `object ids of layer`. Grispr exited 3 and wrote nothing - correct
   fail-loud behaviour, but it could not read the file. It now has a second
   marker mode that infers block ends from `; OBJECT_ID:` / `; CHANGE_LAYER` /
   `; EXECUTABLE_BLOCK_END`. `--list` names which mode it used.
   Note the terminator is the layer change, NOT the timelapse block: the
   object's toolpath resumes after `; SKIPPABLE_END` and the sparse infill
   after it belongs to the object.
2. **The last inferred block swallowed the end gcode**, which contains
   `M106 S0 ; turn off fan` plus the P2/P3 shutdowns. Under `--hold` those
   would have been commented out and the fan left running after the print.
   Inferred blocks are now clamped to the file's last extruding move, which
   fixes it without depending on any comment.
3. **Fan speeds are fractional** - `M106 S196.35` appears 1222 times - and the
   file never uses `M107`, it writes `M106 S0`. Restores were rounding to int
   and could introduce an `M107` the file never used. Both fixed.

The measured number that matters for the module's story:

    105 block(s) across 1 object(s); 105 forced, 23 restored, 5694 suppressed

5694 of the file's 5735 fan commands sit INSIDE object blocks - about 54 per
layer, mostly overhang forcing driving `M106 S255` (2856 occurrences). So
boundary injection, the default, is overridden within a few lines on real
Bambu output. `--hold` is the only mode that does anything lasting on a file
like this. That is measured, not estimated, and it is the opposite of what the
default implies - see limitation 2 in `tools/grispr/README.md`.

Verification on the real file: full `--hold` run, output re-parses to the same
105 blocks, `--force` reverts byte-for-byte to the original (5823 lines
undone), end-gcode fan shutdown still executable.

### Still open on the real-file front

That plate was SINGLE object. Closed by the 2-object slice - see NEXT CHECK at
the top of this entry. The `exclude_object = 1` with no start/stop markers and
no `M624`/`M625` was the tell, and it held.

Grispr refuses to WRITE to an inferred-mode file with more than one distinct
object id, because the block-end guess is verified for the single-object shape
only. `--list` still works on it.

### The original pending note, kept for the record

`--list` had never been run on a real sliced file before 2026-09-14. The marker pattern is
confirmed against genuine Bambu output; Grispr's parser against that pattern is
not. Next slice off either printer:

    python3 tools/grispr/grispr.py --list /path/to/plate_1.gcode

Ping-pong analogue to the bare STL drop: a bare `.gcode` drop, no text, means
"run `--list` on this". Expect the block table; a parse error or an obviously
wrong block count IS the finding. Safe to run on anything - `--list` never
writes, and Grispr exits non-zero without touching the file on any pattern it
does not recognise, rather than reporting a zero-edit success.

## CI - GitHub Actions runs `npm test` on every push

`.github/workflows/test.yml`. Triggers: every push to `claude-wip`, every PR
into `main`, plus `workflow_dispatch`. The job is named **npm test**, so that is
the status-check name to tick in branch protection.

It runs `npm test` as one step rather than listing the suites in YAML, so CI
cannot drift from package.json. Add a suite to the `test` script and CI runs it;
nothing to change in the workflow.

As of 2026-09-15 the wire-* trio is IN `npm test`, so Smooth, Seal->Repair and
Join->Fusion are gated by CI rather than only checked by hand. They run through
`tools/nso_app_harness.js`, not `cth-test/browser-lib.mjs`: that harness resolves
Chromium itself in `chromiumPath()`, which probes `/opt/pw-browsers` and returns
`undefined` on a runner, so Playwright falls through to its own pinned build.
Checked, not assumed. They also exit `fails === 0 ? 0 : 1`, which is what makes
appending them to the `&&` chain an actual gate rather than decoration.

Still NOT in CI, because still not in `npm test`: `grispr:test` (Python) and the
suites for modules that remain unwired - `nso_inside_corners_test.js`,
`nso_paint_scope_test.js`, `nso_selfint_equiv_test.js`, `nso_repair_regress.js`,
`nso_fuse_*_test.js`, `sculpt_selftest.js`. Deliberate. Add to the `test` script
to gate them; the workflow needs no change.

**No CHROME_PATH here, and that is the whole point.** `npx playwright install`
fetches the exact revision the locked Playwright wants
(`chromium_headless_shell` v1243) - the thing the web sandbox cannot do, which
is the only reason CHROME_PATH exists. The sandbox workaround above stays
sandbox-only.

**A runner DOES have outbound network.** Measured 2026-09-15, not assumed:
`cdn.jsdelivr.net` returns 200 for the manifold js (74762 B), the manifold wasm
(541470 B) and three.min.js (607784 B). So CI *could* use the CDN. It does not:
`browser-lib.mjs` serves `vendor/manifold/` and the `three` devDependency, and
`drive-check.mjs` asserts the substitution happened, so the hermetic path is the
tested path and a CDN outage cannot redden the build. The vendored sizes match
the CDN's byte for byte, so the copy is not a stale fork.

Cost on ubuntu-latest: see the commit that added the wire-* suites for the
current figure. Before them it was **42s green** (checkout 2s, node 1s,
`npm ci` 2s, playwright chromium 24s / 114 MiB, `npm test` 10s); the three wire
suites add roughly 14s of browser time. Red is faster, since `npm test` stops at
the first failing suite. No browser cache step - it saves ~20s and adds a
failure mode.

**Negative-controlled, not assumed.** Branch `ci-selftest-negative`, two runs
differing by exactly one line - an off-by-one in `app-mask.js` `nsoMaskCount()`:

    run 1  FAILURE  cth:unit ALL GREEN, then cth:capture 26/27,
                    "FAILED the face was painted (expected 1, got 0)", exit 1
    run 2  SUCCESS  same runner, same workflow, regression removed

`cth:unit` passing first in the red run is what makes it meaningful: a real
browser launched and a real page ran, so the red came from the app, not from a
broken setup. Branch deleted after; the pair is recorded here.

**Still to do by a human with admin rights:** making it merge-blocking needs
Settings -> Branches -> branch protection rule on `main` -> "Require status
checks to pass before merging" -> tick **npm test**. Not doable over the API
with this connector's permissions.

## CTH checks
`npm run cth:unit` is the dependency-free suite (`tools/cth-test/*.test.mjs`,
also runnable as `./tools/cth-test/run-all.sh`). `npm run cth:capture` and
`npm run cth:drive` drive the real app in headless Chromium and need `npm ci`.
`npm test` runs these three, the two 3MF checks and the three wire-* checks -
eight suites, 311 checks - and is what CI runs. Both browser checks serve three and the manifold
kernel from the `three` devDependency and `vendor/manifold/` rather than the
CDN `index.html` names, so they need no network.

## library/CTH_fixture.stl is the drive's INPUT, not its output
It was, for a while, its output. The file carried 1372 triangles, 94% of them
not axis-aligned - a box hull that had already been wrapped. `?cth=drive`
could not run on it: `nsoWrapAllReady` needs `rawBoxPockets() > 0`, a wrapped
piece is no longer a box pocket brick, so the Soften press ARMED instead of
baking and the drive reported `DRIVE FAIL (armed)`. Proof it was the drive's
own output: running the drive on `box_hull_80x40x20-2.stl` emits
"(1372 tris, one bake from source)" - the same 1372.

It is now a copy of `box_hull_80x40x20-2.stl`: 28 triangles, same
80x40x20 bbox, one pocket, a clean brick. Do not save a baked result over it
again. `npm run cth:drive` fails loudly if anyone does.

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

1. ~~`NSO_weldEpsFor` (app-join.js) caps the weld tolerance at the strict
   minimum edge~~ — FIXED in weld-eps1. It now rejects the bottom 0.1% of
   edges that sit >=4x below the next edge up, so the tape's 2 slivers no
   longer pin the mesh: 4.997e-6 -> 4.2397e-5, and the part reads 0 open
   instead of 1402 (NSO_buildAdjacency) / 4 (NSO_edgeStats). All five call
   sites (2 in NSO_unionSoups, 2 in subtractSoupBFromA, 1 in
   joinSelectedModels) inherit it. 50 of 51 repo fixtures are bit-identical.
   `NSO_sculptWeldTol` stays for now — see docs/SCULPT-TIER1.md.
2. `NSO_edgeStats` and `rawCheckWatertightQuick` weld by coordinate
   rounding, so neither can see a backwards-wound face: it pairs every edge
   and reads 0 open while the volume is wrong. `NSO_buildAdjacency` counts
   directed edges (`stackedDirs`) and requires 0 for watertight. This is a
   second, distinct hole alongside the already-parked 208-odd-edge tolerance.
3. `tools/stl_watertight_check.py` rounds to 1e-5, too tight for a float32
   STL of an 82mm part: it reports 1406 false open edges on the tape fixture.

None of the three touched — each wants its own scoped pass and an APPLY.

## Inside corners — the corners8 setback in a pocket (landed, `nso_inside_corners.js`)

Full write-up with numbers: `docs/INSIDE-CORNERS.md`. Suite:
`node tools/nso_inside_corners_test.js` (101 checks). **Not wired in** — no
script tag, no `getEdgeTreat` option, `?v=` NOT bumped.

The ticket asked whether corners8's setback generalises to a concave pocket.
It does not, and the answer is measured, not argued: `softenSelectedFace`
refuses every internal face outright (`clicked face is not the outer plane on
that axis`); `rawVertexBallCorners` drops any corner whose turn opposes the
loop winding and then refuses the whole face; and the blend is subtractive and
two-edged — it closes on a point on the depth edge, which it leaves sharp.

It does not need to generalise. The pocket is cut by a **plug**, and a plug is
convex, so the unmodified engine runs on the plug's floor end and the existing
boolean mirrors it inward. No new geometry maths.

On the standard fixture at R=2: pocket-floor vertices fill **1.2779 mm**, floor
edges **0.8284 mm** (= R(√2−1), exact), vertical wall edges **0.0000**, lid rim
**0.0000**, +53.305 mm³, watertight, 0 self-intersections on
`tools/mesh_validate.py`. inside3's face reporting is unchanged on all six
paint cases, and the paint still drives geometry: painting the pocket wall
x=10 takes exactly its two floor vertices to 0.0000 and leaves the other two
at 0.6369.

**The mask6 both-faces rule was not touched.** The rim stays sharp by the
mechanism already shipping — the plug is pushed 2R+1 past its own mouth, so
only the floor end is treated.

Follows the standing paint rule at the top of this file: `opts.skip` is a
required argument, and painting the pocket floor or any of its four walls
stands the bake down and names the face. The status line is the shape the three
wired bakes adopted — `Pocket corners stood down - N painted face(s); …`,
matching `Smooth stood down - N painted face(s); …` and `Repair stood down -
N …` — and the result carries `painted` as the count with the detail under
`paintedFaces`.

One deliberate difference from that trio: Smooth / Repair / Fusion are
whole-piece operations with no skip list, so ANY paint on the piece stops them
(`nsoMaskCount(m) > 0`). This one knows which faces it touches, so it counts
only the pocket floor and its four walls. Paint on the pocket mouth, or
anywhere on the hull, does not stop it — this treatment never reaches those,
and the resulting bake still measures correct. A painted
wall stops the *whole* bake rather than leaving that one edge square, because
`rawVertexBallCorners` has no per-edge radius and its own rule is
all-four-corners-or-none; giving the setback a per-face radius the way
`rawWrapSolid` has one is a change to live corners8 code and wants its own
ticket and an APPLY.

Three findings land on code this ticket did NOT touch. Each is someone else's
gate and wants its own scoped pass and an APPLY:

1. `rawWrapSolid` has no setback branch — `mode === 'corners'` takes the ball
   path and everything else, **`cornersedges` included**, falls into the
   offset-of-the-shrunk-box branch. So in the whole-solid wrap, Corners+edges
   and Round are the same geometry on hull and pocket alike: identical tri
   count 3868, identical volume 21383.405746, identical probes. In the
   per-face path they are two different engines.
2. `rawVertexBallOnly` emits **72 inconsistently wound triangles** on a plug
   bake that `nsoSealScore` calls 0 open / 0 non-manifold; Manifold refuses it
   as a bare `Not manifold`. That is finding 2 above with a reproduction.
   `NSO_insideEdgeScore` counts directed edges and sees it.
3. `rawBoxPockets` groups faces by PLANE, not connectivity, so two pockets
   sharing any face plane merge into a non-box cluster and **both are
   dropped**. Two identical bays side by side at one depth → 0 found. Every
   face plane distinct → 2 found.

Also one-line and live: the setback's refusal message blames "something
already softened" for what is actually a concave corner.
