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
| Thicken (`app-finish.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment |
| Pocket corners (`nso_inside_corners.js`) | sub-region | this pocket's floor + 4 walls | `docs/INSIDE-CORNERS.md` §2 |
| Skin face (`app-skin.js`) | sub-region | the one face being skinned, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | header comment |

`node tools/nso_paint_scope_test.js` asserts every entry actually carries its
label in source, so a deleted or drifted declaration fails rather than rotting.

## Standing rule — non-solid is the user's call, never the mesh's (added 2026-09-16)
A piece can be flagged **non-solid** (the *Non-solid* checkbox, `m.nonSolid`,
`nsoNonSolid(m)`), meaning it is meant to be open: a vase-mode clip, a
single-wall squishy, a woven sheet of separate strands. Same shape as paint:
per piece, user-set, visible (list tag + checkbox + status lines), undoable,
never inferred from an edge count. What it lifts is exactly one thing, the
"fully enclosed" requirement — hole fill, flap and orphan peel, open-edge
verdicts, volume-based budgets. **Self-intersection, degenerate, non-manifold
and winding checks run unchanged with the flag on.** Full audit, the split per
consumer, and the wall/gap check for thin shells: `docs/NON-SOLID.md`. A new
consumer states `NON-SOLID SCOPE` in its source and reads `nsoNonSolid(m)`;
`node tools/nso_open_flag_test.js` pins it.

Pass/fail for a flagged piece is `tools/mesh_validate.py --gate --non-solid`
(open edges leave the verdict, the wall/gap check joins it), or
`tools/stl_watertight_check.py --odd --degen --non-solid`.

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

## Export round trip + fixture integrity - standing checks (added 2026-09-16)

Two suites added after the infrastructure health pass, both in `npm test`.

**`npm run export:roundtrip`** (`tools/nso_export_roundtrip_test.js`, ~40
checks, headless Chromium through `nso_app_harness`). The general form of the
liftY bug fixed in 1cef66a. Two pieces are posed off-centre - box-20mm yawed
0.7 rad and lifted 3.37 mm, the pocket brick tilted 15 deg and lifted 0.18 mm -
and all four export routes are pressed for real (**Export plate** and
**Download selected**, Format = STL and = 3MF, filename prompt accepted). Each
browser download is re-opened from disk with a parser that is not the app's
(a stdlib binary-STL reader; `nso-3mf-read.js` for 3MF) and compared vertex
for vertex, in order, against `p.geometry` pushed through `p.mesh.matrixWorld`
- what the viewport draws, not the `p.x / p.height / p.liftY` bookkeeping the
exporters read. Then every file goes back in through `handleFiles()` and the
new model's `rawTris` must equal the file soup, untranslated. Measured max
deviation on the plate routes: 8.4e-7 mm (STL) and 2.6e-6 mm (3MF, six-decimal
text); gate is 5e-5.

Conventions the suite pins, all read off the shipped code:
- scene `(x, y, z)` Y-up -> file `(x, -z, y)` Z-up; the scene rests a piece at
  y = 0.2 (`settlePlacedOnBed`), the file at z = 0, so `file_z = scene_y - 0.2`.
- the plate 3MF adds `(plate.w/2, plate.d/2)` for Bambu's front-left origin.
- **Download selected exports the MODEL, not the placed instance**: STL at the
  model's own centred origin, 3MF centred on the plate resting on z = 0. Yaw,
  tilt, lift and x/z are not carried on that route. This is by design (it is
  the list's selection, after Cut / Split edits) and the suite asserts it, so a
  change to the contract is a visible test change. If a user ever needs a
  posed single piece, that is **Export plate** with one piece on it.
- `addModel()` re-centres every import, so file placement survives only in
  `rawTris`. Recorded, not gated.

**`npm run fixtures:audit`** (`tools/fixture_audit.py`; `--gate --no-selfint`
in `npm test`, ~1 s). Every `.stl` under `fixtures/` and `library/`, three
checks: FORMAT (binary: declared triangle count gives exactly the file length,
count > 0, body not printable text - the Contents-API placeholder signature;
ASCII: facets present, three vertices each), CANONICAL (`mesh_validate.py`'s
own `validate()`, imported), and EULER (a surface closed by edge count with an
ODD characteristic is a vertex pinch - the 40921 bowtie that
`stl_watertight_check.py` passed - reported as PINCH). Only FORMAT gates:
`fixtures/repair/` and `fixtures/open/` are defective on purpose. Run it bare
for the full table with self-intersection, or `--root <checkout>` against
another branch. `mesh_validate.py`'s binary reader stops quietly at the end of
a short file, which is why FORMAT is a separate check and not a flag on it.

First run, 2026-09-16, `main` at 1315fc2 (51 files) and `claude-wip` at
a228ab0 (67 files): 0 FORMAT failures on either. Odd Euler on exactly the
three pinch fixtures (`synth_pinch_2sheet_safe`, `_tight`, `40921`), all
documented. Files that fail the canonical verdict and are NOT documented as
intentional: `fixtures/out-box-square-half.stl` (1 degenerate triangle) and,
in both `fixtures/` and `library/`, `hinge_knuckle_box` (234 piercing pairs),
`hinge_knuckle_lid` (124), `hinge_pip` (330, Euler 12 - several
separate shells), `lid_strap` (25, Euler 4), plus `library/box_closed` (74, Euler 4).
Those are multi-body STLs whose shells overlap; a slicer unions them, so they
print, but they are shipped in `library/` as product files and any CSG route
(Join, Subtract) will meet the overlaps. Resolved later the same day: the four
hinge / strap pairs are now real boolean unions of their shells (0 piercing,
`tools/nso_fixture_union.mjs`, numbers in `fixtures/README.md`);
`library/box_closed` is left as is and documented as not CSG-safe in
`library/README.md`, because the sculpt self-test and `docs/SCULPT-TIER1.md`
measure against its two-shell layout. The `skin_*_block` samples read
piercing pairs because their gap is exactly 0 and the checker has no
"touching along an edge" class (same as the Seat-gap 0 case). The tape files
are the documented CSG_INTEGRATION case.

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

`.github/workflows/test.yml`. Triggers: every PR into `main`, every push to
`main` or `claude-wip`, plus `workflow_dispatch`. The job is named **npm test**,
so that is the status-check name to tick in branch protection.

It runs `npm test` as one step rather than listing the suites in YAML, so CI
cannot drift from package.json. Add a suite to the `test` script and CI runs it;
nothing to change in the workflow.

**THE WORKFLOW FILE MUST EXIST ON `main`.** Learned the hard way on 2026-09-15,
and it is invisible if you do not know it. For a `pull_request` event GitHub
reads workflow definitions from the PR's MERGE REF - base merged with head - not
from wherever the file happens to live. While `test.yml` was only on
`claude-wip`, PRs into `main` queued NO run at all: not a failure, not an error,
no entry in the Actions list to find. The required check simply sat on "Expected
- waiting for status to be reported" forever and blocked every merge into main.
Searching Actions for the branch returns nothing, because nothing was ever
created. A branch may carry a newer copy, but `main` must always have one.

Corollary, and the reason a PR can fix this at all: a workflow added in a
same-repo PR IS in that PR's merge ref, so such a PR runs its own check and
bootstraps itself out of the deadlock. PR #46 did exactly that.

**The workflow deliberately does not list the suites or their check counts.**
It used to. The inventory drifted within a single day - the commit that added
`3mf:import` and `3mf:import-drive` to the `test` chain updated the comment's
total but not its table, so the file shipped claiming nine suites when
package.json ran eleven. package.json's `test` script is the one definition;
read it there. The check NAME is what branch protection pins, and that stays
`npm test` however the suite grows. The copy on `main` and the copy on
`claude-wip` are byte-identical, deliberately, so they cannot conflict on merge.

As of 2026-09-15 the wire-* trio is IN `npm test`, so Smooth, Seal->Repair and
Join->Fusion are gated by CI rather than only checked by hand. They run through
`tools/nso_app_harness.js`, not `cth-test/browser-lib.mjs`: that harness resolves
Chromium itself in `chromiumPath()`, which probes `/opt/pw-browsers` and returns
`undefined` on a runner, so Playwright falls through to its own pinned build.
Checked, not assumed. They also exit `fails === 0 ? 0 : 1`, which is what makes
appending them to the `&&` chain an actual gate rather than decoration.

Still NOT in CI, because still not in `npm test`: `grispr:test` (Python) and the
suites for modules that remain unwired - `nso_inside_corners_test.js`,
`nso_paint_scope_test.js`, `nso_repair_regress.js`, `nso_fuse_*_test.js`,
`sculpt_selftest.js`. Deliberate. Add to the `test` script to gate them; the
workflow needs no change.

**`npm test` needs python3, not just Node and Chromium.** `selfint:equiv` spawns
`python3` per fixture - it is the only thing keeping `tools/mesh_validate.py` and
the transcription in `NSO_Repair.js` from drifting apart again, which is how
three copies of that checker came to exist. There is no `setup-python` step:
ubuntu-latest ships Python 3 on PATH and the green runs are the evidence. If a
runner image ever drops it, this is the suite that breaks first, and the fix is a
`setup-python` step in the workflow, not a change to the test.

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

## Seat with a gap (2026-09-16)
`app-join.js`, `NSO_seatFlushBitToHull` and two buttons in the Join card:
**Seat flush** (the plug seat, never reads the slider) and **Seat (support)**
with the gap **slider** `#seat-gap` (`-0.25 .. +0.05` mm by `0.01`, default
`-0.18`, mid easy-release) and its exact readout `#seat-gap-value`. Check:
`npm run seat:gap` (`tools/nso_seat_gap_test.js`, in `npm test`).

*History:* the gap first shipped as a number field beside a single Seat flush
button (blank = flush, number = gap). Split 2026-09-16 into the two buttons
above so the flush path can never be reached with a stale number in a field,
and the slider replaces typing: 0.01 steps sweep the plateau-to-weld boundary
(`-0.25` air .. `+0.05` overlap) without sub-hundredth noise. The bullets
below say "gap field" where they predate the split; read "slider".

**What Seat did before this.** It was never flush-only and it never had a
"gap". The core always took `opts.proud` (default 0.4): the distance the bit's
OUTER face - the one facing away from the hull - ends up outside the hull
skin. The button hardcoded `{ proud: 0.01 }`. So "Seat 0.01" on a real part
meant: bury the bit in the hull until its outer face stands 0.01 mm proud of
the skin, ready for Subtract to carve the pocket. Measured before the change
on `box_hull_80x40x20-2` + `box-20mm`: bit top 0.01 mm above the hull top,
bit bottom 19.99 mm below it. That is a plug seat, not a surface seat, and
`proud` is the wrong quantity for a breakaway piece.

**What changed.** A second, exclusive option: `{ gap: g }`. `g` positions the
bit's MATING face (the one facing the hull) off the skin, in the sign
convention `tools/breakaway_coupons.py` locked in its JSON
(`gap_overlap_mm`): **negative = air gap of that size, positive = the bit
penetrates the hull by that much, 0 = touching**. Easy release is
`{ gap: -0.18 }` (locked range -0.15 .. -0.20). Same corner rays, same tilt
fit, same translate along the fitted normal; only the reference face and the
sign differ. Passing `gap` together with `proud` or `lip` is refused. The
result carries `mode`, `gapAchieved`, `gapMin`, `gapMax` (coupon convention)
alongside the old keys. The flush path (`proud`) is byte-identical: the test
pins the pre-change pose to 1e-9 and the status line to the character.

**The buttons.** Seat flush = the old flush seat, unchanged (status
`Seated - proud 0.01mm ...`), whatever the slider shows - the test drags the
slider to +0.05 and clicks it, golden pose to 1e-9. Seat (support) = gap seat
at the slider's value, status
`Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`; the
measured value keeps its sign so a wrong-way seat can never read as right.
The slider is the control; arrow keys step 0.01, the readout shows the exact
value the next click will use, and a value set from code outside the range
clamps (the browser's own range sanitisation) so the readout and the seat
can never disagree. Seat (support) with the slider missing refuses.

**Two things the gap path does that the flush path does not.**
1. It settles the hull onto the bed baseline first (`settlePlacedOnBed`, what
   Align edges already does via `matchPlacedBottoms`). A dropped, never-moved
   piece sits 0.1 mm higher than a settled one, and `liftY` - what the exports
   write - is measured from the settled baseline. Left alone, that 0.1 mm
   would have landed in the exported gap; the whole easy-release window is
   0.05 mm wide.
2. Both plate exports (`buildCombinedGeometry` for STL, `buildPlacedObjects3MF`
   for 3MF in `app-core.js`) now add `liftY` to the piece's height. Before,
   every piece exported resting on z = 0 whatever the scene showed, so a
   seated gap - or any Lift - was silently dropped from the file the slicer
   gets. An unlifted piece exports exactly as before (the 3MF drive check's
   "rests on z = 0" gate still holds).

**Validation numbers (gap -0.18, real button, real export, canonical checker
`tools/mesh_validate.py --json`).** Scene: mating face +0.180001 mm above the
skin (the 7.6e-7 is the hull's Float32 soup). Export: 40 triangles, 0 open,
0 non-manifold edges, volume 71360.000 = hull 63360 + bit 8000, 0 piercing
pairs, 0 coplanar pairs, bbox height 40.18; the two shells split off the STL
are 0.1800003 mm apart; 3MF objects the same. Controls: +0.05 puts the
mating face 0.05 mm inside the hull, the checker sees 10 piercing pairs and
bbox height 39.95; 0 puts it on the skin to 7.6e-7 and the checker sees 4
coplanar contact pairs, which an air gap never produces.

**Known limits.** The plug frame picks the punch axis from the hull, so the
bit must sit roughly over the target face (Center X / Z first). On a curved
hull the seat tilts the bit through `mesh.quaternion`, which the export
transform chain (rotY / tip / roll) does not carry - a flat target is exact,
a tilted gap seat exports untilted. The two-shell touching case (gap 0)
reads as piercing pairs in `mesh_validate.py` because the checker has no
"touching along an edge" class; it is the coplanar count that separates
touching from an air gap.

## Contact skin on a face + Seat against the skin's tips (2026-09-16)
`nso_skin.js` (pure geometry, browser + Node), `app-skin.js` (the **Skin face**
button and pattern select in the Join card), `NSO_seatFlushBitToHull` gap mode
in `app-join.js` (tips reference). Samples: `fixtures/skin-samples/`
(`npm run skin:samples` regenerates, the test fails on drift). Check:
`npm run skin:test` (`tools/nso_skin_test.js`, in `npm test`).

**Audit before building.** Nest had no way to put a pattern on an existing
face. What existed: the sibling branch `claude/breakaway-coupon-*` builds
`ring` / `grid` anchor tips as their own closed shells sunk 0.2 mm into a
coupon body (`tools/breakaway_coupons.py` + `tools/meshlib.py`, volumetric
overlap, never on `claude-wip`); the app's bakes (Soften, Smooth, Repair,
Solidify, Thicken, inside corners) reshape a piece but none add relief to a
face. `nso_mesh_triangulator.js` and `skin_join_test.stl`, referred to in the
ticket, exist on no branch of this repository. So this is new, written to
the house shape: one pure module, one wiring file, one harness test.

**What Skin face does.** Picks the planar face of A whose normal best matches
a direction (toward B in a Join session, else +Z / top), outermost if several
are parallel; requires its boundary to be a rectangle. Removes that face,
builds the relief over the same rectangle with the original loop as its
perimeter, and re-fans every wall triangle that borders the face so each new
perimeter vertex is shared - one closed shell, Euler 2, 0 piercing on every
pattern, volumes match the analytic relief volume to 1e-3 (test part 1).
Patterns: `crosshatch` (ribs both ways, 0.42 wide, 1.2 pitch, 0.6 tall - the
fine mesh; the v8_FINAL printed interface is not in the repo as geometry, so
these are stated defaults, all parameters), `zigzag` (sawtooth-section
ridges, 0.42 crests, 2.0 pitch), `ring` (the coupon anchor tip, r 5, wall
0.8 -> 0.4, 1.0 tall). `mode: 'recess'` cuts the valleys down instead and
keeps a rim at the margin (needs margin > 0; ring is raise-only). Undo type
`skinReplace`. **PAINT SCOPE: sub-region** - only the face being skinned is
checked (`nsoMaskIsExcludedRaw` with the picked plane, axis and side when
axis-aligned); paint on any other face does not block, and those faces are
untouched by construction. A painted target face stands it down by name.

**The two surfaces, and which one Seat measures.** A skinned face has a base
plane (the floor between features) and a tips plane (rib tops / crests /
ring top, `height` above the base). The four corner rays Seat has always
cast land on whichever is under each corner - on the sample pairing all four
land in valleys - so a gap measured that way would seat B `height` deep in
the relief and print a solid fuse. Gap mode now probes first:
`NSO_Skin.supportExtreme` takes the hull's outermost point along the bit's
normal over the bit's FOOTPRINT (every hull triangle clipped to it, so a rib
whose end vertices lie outside the footprint still counts where it passes
under B), and compares it with the corner-ray plane. Rise > 0.01 mm
(`NSO_SEAT_TIPS_TOL`; a relief is a printed layer or more, a flat Float32
face measures ~1e-6) means a skin: B is translated along its own normal so
its mating face sits `gap` off the TIPS, untilted, and the result carries
`reference: 'tips'`, `tipRise`. A flat hull takes the corner-ray path
unchanged - `tools/nso_seat_gap_test.js`'s golden pose still holds to 1e-9 -
and reports `reference: 'plane'`. The status line appends
`- from skin tips, relief 0.60mm above the base plane`, so a seat that
measured from the wrong surface can never read the same as one that did not.
Limit: tips mode assumes B's mating face is parallel to the skinned face
(Center X/Z, upright); it does not tilt-fit a skin.

**Samples** (`fixtures/skin-samples/`, Z up, mm): A 30 x 30 x 8 on z = 0,
skinned on +Z; B 20 x 20 x 6 centred, underside on the tips (gap 0). One
`_block.stl` per pattern holds both shells (split to objects in the slicer,
or import the `_A` / `_B` singles, which share coordinates);
`skin-samples.json` carries the numbers. Measured through
`tools/mesh_validate.py --json` (test part 2): A alone Euler 2, 0 piercing,
0 coplanar; A+B 0 open, 0 non-manifold, Euler 4, volume = A + B to 1e-6,
exactly two edge-connected shells, A's highest z == B's lowest z bit for bit
(zero penetration), that plane 0.6 (ring: 1.0) above the base plane, coplanar
contact seen. Contact under B: crosshatch 234.6 mm^2, zigzag 84.0, ring 11.55
(of a 400 mm^2 footprint). Controls: gap -0.05 -> 0 piercing, 0 coplanar,
shells 0.05 apart; +0.05 -> piercing. As with the Seat-gap check, gap 0 also
reads as piercing pairs in the checker because rib walls stand edge-on in
B's plane and it has no touching-along-an-edge class; the -0.05 control and
the exact z equality are what separate touching from penetration.

**Reachability (audited 2026-09-16, second pass).** Both are wired in the
live app, not only committed: `index.html` loads `nso_skin.js?v=skin1`
before `app-core.js` and `app-skin.js?v=skin1` after `app-join.js`; the Join
card carried `#btn-skin-face` + `#skin-pattern` (crosshatch / zigzag / ring)
- **moved to the Finish tab later the same day, under the paint row, see
"Face select"** - and, from the Seat-gap commit, `#seat-gap` (now a slider
under `#btn-seat-support`, see "Seat with a gap"). The
mirror workflow run for `7ed4821` succeeded and the `nest-wip` tree carries
the same `index.html` (README source SHA matches), so the preview site at
<https://nolongerzzz.github.io/nest-wip/> serves it once Pages finishes its
deploy. Nothing needed wiring.

**Drive check** (`npm run skin:drive`, `tools/nso_skin_drive_check.js`, in
`npm test`): the whole flow through the shipped controls, on the real
fixtures box_hull_80x40x20-2 (A) + box-20mm (B): file input, Start Join,
Pick A / Pick B via the slot buttons and the list rows, Raise x11, pattern
select, Skin face, `-0.18` typed into the gap field, Seat flush, Format = STL,
Export plate - and the browser's actual download through `mesh_validate.py`:
two shells 0.18 apart, hull 20.6 tall, 0 piercing, 0 coplanar, height 40.78.
Then Undo x2, ring, gap 0, Seat, Export: hull top == bit bottom, coplanar
contact, height 41. The one step that is not a click is moving B over A
(there is no button; a viewport drag calls `selectPlaced` + `nudgeSelected`,
which the check calls directly and labels as such). `APP_URL=<site>` points
the same check at a deployment; the harness serves the three.js CDN tags
locally either way. Not run against the preview site from the sandbox - its
egress policy blocks `github.io` - so that run is the user's, or a runner's.

**Through the real app** (test part 3): plain block A + box-20mm B, Seat 0 on
the flat A -> `reference 'plane'`; Skin face -> A's raw soup replaced, 8.6
tall, undo restores 12 tris; painted +Z stands down, paint on -Z does not;
sphere refused; Seat 0 on the skinned A -> B's underside on A's world top to
2e-6, hull height 8.6 (not 8), status names the tips, core `tipRise` 0.600,
`gapAchieved` 0; Seat -0.18 -> plate export 2 shells 0.18 apart, 0 piercing,
0 coplanar, height 28.78; Seat +0.05 -> 0.05 into the relief.

## Multi-piece plate export, checked piece by piece (2026-09-16)
`npm run export:multi` (`tools/nso_multi_export_check.js`, in `npm test`,
93 checks). The Seat-gap and Skin checks each prove one pair; this one puts
**five pieces in three independent states** on one plate through the shipped
controls and matches every exported shell to its scene piece:

- free: `box-20mm` loaded first and never touched, left where the drop put it;
- pair 1: `box_hull_80x40x20-2` + `box-20mm`, Seat (support) at -0.18;
- pair 2: `box_hull_80x40x20-2` + `box-20mm`, Skin face crosshatch, then
  Seat (support) at -0.05 (a different gap, so the two pairs cannot be
  confused in the file).

Real numbers, from the browser's actual downloads. STL through the canonical
checker `tools/mesh_validate.py --json`: 34,660 triangles (12 + 28 + 12 +
34,596 + 12, the sum of the five raw soups), 0 open, 0 non-manifold, Euler
10 (five closed shells), **0 piercing, 0 coplanar**, volume 151,728.834 =
the five raw soups to 2e-3 (2 hulls 63,360 + 3 boxes 8,000 + 1,008.834 mm³
of crosshatch relief). Split into edge-connected shells: exactly five; every
shell's X/Y extents equal the scene's world box **to 0.00e+0**, height
equal, bottom at the piece's `liftY` (0, 0, 20.18, 0, 20.650002), triangle
count and signed volume equal to the piece's own raw soup (the 34k-triangle
skinned hull lands 6e-4 mm³ off, float32). Pair gaps measured off the
shells: **0.180000** and **0.050001**; A2 20.6 tall, A1 20.0 (no skin leaked
across pairs); both bits inside their hull's footprint; smallest plan
separation between assemblies 5.000 mm, no overlap. The 3MF route: five
objects in plate order, same extents +90, gaps 0.180000 / 0.050002, every
vertex inside the 180 mm plate. Neither export moved anything in the scene
(every pose field and world box identical before and after), and a second
STL export after selecting every piece in turn is **byte-identical**
(1,733,084 bytes).

One number worth knowing, pinned rather than fixed: the scene draws a
settled piece 0.2 mm above the bed and a never-moved piece 0.3 mm above it
(`placeModelMovable`'s drop baseline vs `settlePlacedOnBed`); the export puts
both on z = 0. The 0.1 mm is in the viewport, not in the file. Seat already
settles A first for this reason ("Seat with a gap", above).

## Thicken in / out - one-sided planar offset (2026-09-16)

Live testing reported two things: the result of Thicken in / out was a
stepped "waffle", and Thicken in moved the outside face. Both reproduced
through the shipped buttons and the real download (open box `fixtures/
box_open.stl`, 60x40x25, 2 mm walls, open top; solid `box-20mm.stl`):

| piece, op, 1.5 mm | tris | asked | delivered | outer bbox | volume |
|---|---|---|---|---|---|
| open box, in | 68 -> 82,264 | cavity wall +1.5 | cavity wall -0.24 (thinner) | 60 -> 59.77 | 13632 -> 12104 |
| open box, out | 68 -> 90,808 | outer +1.5 | outer +1.64, cavity -1.76 | 60 -> 63.28 | 13632 -> 36789 |
| cube, in | 12 -> 33,708 | nothing | shrank 0.125 | 20 -> 19.88 | 8000 -> 7851 |
| cube, out | 12 -> 42,900 | +1.5 per side | +1.25 per side | 20 -> 22.5 | 8000 -> 11165 |

**Root cause (audit).** Thicken was a voxel dilate, not a surface offset:
rasterise into a grid capped at 110 cells per axis (pitch 0.375-0.59 mm on
these parts), flood-fill the grid border to label "exterior", grow the solid
N cells, throw the mesh away and emit a cube face per exposed voxel face.
The waffle is those cube faces; the offset is quantised to whole cells.

**Wrong-side leakage had two independent causes.** (1) Every face was
re-sampled, so the side that should be untouched was rewritten and shifted
by up to a cell - the outer face moved inward 0.12-0.23 mm on Thicken in,
and the solid cube lost 149 mm3 with nothing to thicken. (2) In/out was
decided by connectivity to the grid border, not by which side of the wall a
face is on. Any open cavity - the slot and cup shapes the code comment said
Thicken is for - read as "exterior", so Thicken in found no interior and
did nothing but the damage in (1), and Thicken out grew the cavity face too
(wall 2 mm -> 5.27 mm).

**Now** (`app-finish.js`, `_thickenOffsetSoup` and friends; header comment
carries the full rule). A face is OUTER when its plane supports the convex
hull, or is reached from one across creases shallower than 45 degrees (the
rest of a curve, a rounded edge, a knuckle's far side); everything else is
INNER. Thicken out moves the outer faces, Thicken in the inner ones, by the
intersection of offset planes at each vertex (exact up to three plane
directions, area-weighted normal push beyond that, minimum-norm on flat
faces and edges). Triangle count does not change; a held face whose
vertices touch no moving face is bit-identical. Refused, piece unchanged, no
undo pushed: no face on the asked side (Thicken in on a solid), a face that
would turn inside out (offset bigger than the feature), a rise in piercing
self-intersections (NSO_Repair's canonical count), or paint (whole-piece,
see the roster). Inner patches under 0.16 mm2 ride with the skin; slivers
(under 0.01 mm2 or thinner than 0.1 mm) get no inversion verdict, the
piercing gate still covers them. A pocket whose rim is rounded reads as
outside skin - Thicken in wants a sharp rim, which is what the box hulls
and bits have.

**Validated** (`npm run thicken:drive`, in `npm test`; every step a click,
every file the browser's download through `tools/mesh_validate.py`):
open box in 1.5 -> 68 tris, 0 open, 0 nm, Euler 2, 0 piercing, outer bbox
60x40x25 unchanged, cavity walls 2 -> 3.5, floor 2 -> 3.5, volume 22396.5
(= 60000 - 53*33*21.5); out 1.5 -> bbox 63x43x28, cavity 56 wide as before,
volume 26460. Cube out -> 23 mm, 12167. Tube (genus 1) in / out: bore or
skin only, the other within 3e-3. Sphere out 1.5 -> all 2208 vertices within
3e-4 of radius 11.5, volume ratio 1.52088 vs (11.5/10)^3. Inward-wound
`library/USB_bit.stl` still grows outward, winding kept. Hinge knuckle box:
1.5 refused (knuckle gaps), 0.3 in / out watertight with Euler -4 kept. The
tape (186 piercing pairs before anything is done to it): out 0.3 refused by
the piercing gate, in refused (rounded slot rims), download identical.
Offsets are now exact, not quantised: 1.5 asked is 1.5 delivered.

## Position lock (2026-09-16)
`app-poslock.js`, the **Lock position / Unlock position** button in the
viewport bar (`#btn-lock-pos`). Check: `npm run lock:test`
(`tools/nso_poslock_test.js`, in `npm test`, 74 checks).

**Audit first - nothing existed.** `grep -in lock` over the loaded scripts
hits three things, none a piece lock: app-ux.js's "Look locked" (the orbit
target, camera only), Join's "Lock faces (optional)" (`state.joinUseFaces`,
the face-pick mode), and `setCutAxisLock` (the cutter axis). The two
per-piece user-set flags that do exist are mask6's paint
(`m.faceMask.exclude`, app-mask.js) and the non-solid flag (`m.nonSolid`,
app-nonsolid.js): both live on the model object, both have one accessor,
an undo entry and a list tag. Nothing gated any move path: `startMoveDrag`
checked only `state.cutterOpen`; `nudgeSelected`, `liftSelected` and the six
pose functions checked only that a piece was selected. So this is built on
the non-solid shape, not on a new one.

**What it is.** `m.posLock` on the model (so it survives every bake that
swaps `p.mesh`), read through `nsoPosLocked(m)` / `nsoPosLockedPlaced(p)`,
set only by the button through `nsoPosLockSet`, undo type `posLockReplace`.
The gate is `nsoPosLockBlocks(p, verb)` at the top of the nine move paths in
app-core.js: `startMoveDrag`, `nudgeSelected`, `liftSelected`,
`rotateSelected`, `flipSelected`, `tipSelected`, `rollSelected`,
`bankSelected`, `tiltSelected`. Locked: the call returns, nothing moves, no
undo entry, status `Locked - drag refused on <name> - press Unlock position
to move it`. Indicator: `locked` tag on the list row, a teal edge outline
as a child of the mesh (re-attached by `nsoPosLockRefresh`, which
`renderModelList` and `updateAdjustUI` call, so a bake's new mesh gets it
back), the 15 move/pose toolbar buttons greyed while a locked piece is
selected, adjust-status `Locked #n`.

**What it deliberately does not block:** Seat flush, Seat (support), Center
X / Z, Align edges, Skin face, the library's seat-on-arrival, Undo. None
read the flag. Lock after Seat has placed the piece; Seat on a locked piece
still seats it, because the user pressed Seat. A clone of a locked piece is
a new model and starts unlocked. In-memory only, like the paint: not in the
STL or the 3MF.

**Validation, real interaction.** Playwright's mouse pressed on the locked
piece and pulled 80 px: every pose field and the world box unchanged, no
undo entry, no drag left armed, status names the refusal; the same gesture
unlocked moves it 29.773 mm and reports `Moved model #2` (the control), and
Undo puts it back to 1e-9. The nudge primitive, Raise/Lower and the six pose
functions each leave the locked piece unchanged and name the refusal; the
four arrow keys are a no-op (the app binds no nudge keys - pinned). Seat
(support) on a locked B: seated, liftY 20.18, 0.18 above A to 2e-6, still
locked. Skin face on a locked A: baked (28 -> 34,596 tris), x/z untouched,
lock and outline on the new mesh. Export with A and B locked, C free:
34,620 tris, 0 open, 0 non-manifold, Euler 6, 0 piercing, 0 coplanar, B
0.180000 above A's tips; the STL is **byte-identical** (1,731,084 bytes)
with nothing locked and again with everything locked.

## Face select - the target, next to the paint (2026-09-16)
`app-mask.js` (the second list and the second mode), `app-skin.js` (the one
consumer), `nso_skin.js` (`findFace` takes a plane), `index.html` / `styles.css`
(the Finish tab rows). Check: `npm run select:test`
(`tools/nso_face_select_test.js`, in `npm test`, 72 checks: 15 in Node on a
pocket block, the rest through the shipped controls in headless Chromium).

**Audit first (Task 1), what was found.**

- *Join's "Lock faces (optional)"* is a dead stub, not a mechanism.
  `#btn-join-faces` is in no `index.html`; `app-join.js` hides it if it ever
  appears; `state.joinUseFaces` is read in two places and written only to
  `false`. What Join actually does when a slot is armed is
  `capturePlanarFace(hit)` (app-finish.js): it refuses the top ("Click a
  side wall, not the top"), returns a DISPLAY-space wall (`axis` x|z, `sign`,
  `worldTris` for the cyan highlight) and parks it in `state.joinFaceA / B`
  - session state, dropped by Cancel Join, shown only in the slot label, and
  consumed by nothing else (grep). Three reasons it is not the base for a
  target face: wrong space (world/display, not the piece's raw plane), wrong
  scope (a session, not the piece), and it is a second face resolver next
  to `nsoFaceFromHit` - the "second mapping" the paint rule above forbids.
  It was left exactly as it is.
- *The reusable picker is the paint's.* `nsoFaceFromHit` (one answer to
  "which face"), `faceUnderCursor` for a curved patch, the entry shape
  `{n, d, axisIdx, keepMin, dispAxis, dispSign, dispPlane, inner}`, the
  overlay that lights faces by the axis / side / plane the click recorded,
  the click-ownership predicate `nsoMaskTakesClick`, and the `maskReplace`
  undo. The select is built on all of that, as a second list on the same
  object.
- *Skin's auto-pick* is direction only: `NSO_skinDirForModel` gives raw +Z
  outside a Join and the A-centre -> B-centre direction inside one, and
  `NSO_Skin.findFace(soup, dir)` takes the coplanar group within 30 degrees
  of it, best dot, then the OUTERMOST plane. So it could never name a pocket
  floor, and it had no input other than the direction. An explicit selection
  therefore **overrides** the auto-pick, it does not coexist with it: Skin
  takes exactly one face, the selection is that face when there is one, the
  direction pick is the fallback when there is none, and the status line
  says which (`target: selected target` / `auto-pick: faces B` /
  `auto-pick: top face`). Paint still wins over both: a target that is also
  excluded stands Skin down by name.

**Two flags, two questions (Task 2).** `m.faceMask` now carries
`exclude: []` (unchanged: any number of faces, yellow, every bake's skip
list, `nsoMaskIsExcludedRaw` / `nsoMaskFaceList` / `nsoMaskCount`) and
`select: []` (new: at most ONE face, pink `#f472b6` - the colour no other
per-piece marker uses - read through `nsoMaskSelected(m)`, count
`nsoMaskSelectCount`, membership `nsoMaskIsSelectedRaw`, consumed with
`nsoMaskSelectClear(m, {noUndo})`). Same entry shape, same pick, both stored
as planes so both survive a bake. A face may be on both lists; that is two
true answers, not a conflict. `nsoMaskSnapshot` returns `{exclude, select}`
and `nsoMaskRestore` takes that or the older bare exclude array, so every
existing undo entry and test still restores. `state.maskPaint` is now
`false | 'exclude' | 'select'` - truthy while either session is live, which
is all app-core's click routing ever asked.

**The paint row (Task 3)**, Finish tab: **Paint Selected** (`#btn-mask-select`)
/ **Paint Excluded** (`#btn-mask-paint`, the old Paint faces) / **Clear
paint** (`#btn-mask-clear`, now drops BOTH lists). Paint Selected is
single-target: a click on a face makes it the sole target, a click on another
face moves the target there (status says `replaces the Y+ face`), a click on
the current target clears it. Multi-select was not built: Skin is the only
consumer and takes one face; a consumer that needs more adds a list, not a
meaning. Each click is one `maskReplace` undo step.

**Moved into the Finish tab (Task 4)**, directly under the paint row: `Skin
face` + the pattern select (were on the Join card), and `Cap open faces` (was
on the Join card). All three are bound by id (`app-skin.js`,
`app-join.js` setupUI), so nothing was rewired. The one consumer that did
break was the tests: a control inside the Finish `<details>` is not visible
to Playwright's `page.click` until the menu is open, so
`tools/nso_app_harness.js` gained `openFinishMenu(page)` (clicks the
summary, idempotent) and the four suites that press Skin
(`nso_skin_test`, `nso_skin_drive_check`, `nso_poslock_test`,
`nso_multi_export_check`) call it first. The skin drive also asserts the
new placement (`.vp-finish #btn-skin-face`, none of the three left in
`#join-card`). The cth capture check drives paint through `#btn-mask-paint`
and `!!state.maskPaint`, both unchanged.

**Drive check (Task 5)**, `tools/nso_face_select_test.js`, through the
shipped controls, A = box_hull_80x40x20-2 with B = box-20mm BESIDE it on +X
so the auto-pick has a wrong answer to give:
- no target, Skin face -> `Skinned +X face ... target: auto-pick: faces B`,
  A's raw X 80 -> 80.6, Z stays 20. Undo.
- Paint Selected, a real `mouse.click` on A's top in the viewport (the aim
  is asserted first: the app's own ray from that client point lands on that
  piece's Y+ face, and `elementFromPoint` is the canvas) -> one select entry,
  raw +Z at d = 10 (the fixture is centred), exclude list still 0, pink on
  2 tris, HUD `target Y+ face`. Skin face -> `Skinned +Z face ... target:
  selected target`, raw Z 20 -> 20.6 and **X stays 80** - the selected face
  got the relief, not the one that looks at B. Export plate: the downloaded
  STL's hull shell is 80 x 40 x 20.6, two shells, 0 open. Undo (button)
  puts back geometry AND target in one step (the commit's `prevMask`).
- one target at a time: +X replaces top, same face again deselects, undo of
  a select is its own step.
- paint wins: Paint Excluded on the same top -> both lists hold it, yellow
  and pink both drawn, Skin -> `Skin stood down - +Z face is painted`.
- Clear paint -> both lists empty; Skin falls back to the auto-pick (+X).
- an inner face: the Node part's 30x30x10 block with a 20x20x5 pocket is
  written to disk and loaded through the file input; a click on the pocket
  FLOOR records `inner: true, d = 5`; Skin face skins the floor, height stays
  10, status `Skinned inner +Z face`. With no target the auto-pick finds the
  rim and refuses it (not a rectangle) - the same piece Skin could not touch
  before.
- Cap open faces from its new row answers `No open face to cap` on the hull.

Known limits, stated not solved: the overlays draw for the ACTIVE piece
only (as the yellow always did), so a target painted on a non-active piece
is recorded but not lit until that piece is selected; the select is
in-memory like the paint, not in the STL or 3MF.

## Vertical stacking - Seat (support) from the bed, Align edges keeps the seat (2026-09-16)
`app-core.js` `matchPlacedBottoms`, `app-join.js` `NSO_raiseBuriedBitClear` /
`NSO_restoreRaisedBit` around the two Seat buttons. Check: `npm run seat:align`
(`tools/nso_seat_align_test.js`, in `npm test`, 51 gates). Live report: "Seat
(support) does not seat or magnet at all when stacking; Align edges sinks the
top piece to the plate when it sits above a support" (Join's Align was right).

**Audit - what actually happened, through the real app.** Both reproduced,
and they chain, but the causes are separate.

1. *Align sank the bit.* `matchPlacedBottoms` settled both pieces (which
   honours `liftY`) and then forced both world-box bottoms onto 0.2 outright.
   For a bit Seat had stacked at liftY 20.18 that put the mesh on the plate,
   inside the hull, while the record still said 20.18: the scene showed the
   bit sunk and the export still wrote it stacked. Align did not treat the bit
   as unpositioned and did not ignore the seat; only that last bed-squaring
   was wrong, and only for a lifted piece. Its XZ snap (edge flush with the
   hull's edge, "Aligned to A's inner wall") is the Join behaviour and stands.
2. *Seat (support) did not seat.* A part dragged over the support block rests
   on the bed inside it (drag never lifts). `NSO_plugFrame`'s exit probes read
   the open air BELOW the plate as clear of the hull, so for a part shorter
   than the hull it picked a downward seat; the core then said
   `... held at plate level: gap NOT as requested` and the part never moved.
   A part as tall as the hull happened to go up, but via the tips probe by
   accident (`from skin tips, relief 20.00mm` on a plain block). And after
   the old Align had sunk a stacked bit flush inside the hull, Seat failed
   with `corner 0 missed hull along punch axis` - the corner rays ran along
   the hull's own faces. That chain (Seat ok, Align sinks, Seat fails) is the
   "does not seat at all" in the report.

**Fix.** Two small, local changes; `NSO_seatFlushBitToHull` is untouched, so
`tools/nso_seat_gap_test.js`'s golden flush pose still holds to 1e-9.
- `matchPlacedBottoms` squares each piece onto `0.2 + liftY` instead of 0.2.
  An unlifted piece is bit-identical (0.2 + 0), so Join's Align and
  `joinHalvesOnPlate` see no change; a seated or Raised piece keeps its
  lift. Pinned: side-by-side Align lands on the pre-change box to 1e-9.
- Both Seat buttons call `NSO_raiseBuriedBitClear` first: a bit whose
  underside is below the hull's top while its XZ box lies inside the hull's
  (0.05 pad) is raised to 5 mm above the hull's top (liftY only - XZ and
  quaternion untouched) and seats from above, the pose the corner-ray fit is
  built for. Nothing can seat below the plate, so "down" was never an
  answer. The seat then measures its own liftY from the result as before.
  The undo entry is pushed before the raise; a failed seat puts the bit back
  exactly (`NSO_restoreRaisedBit`). A bit already above the hull, beside it,
  or overhanging its footprint is left alone - those paths are unchanged.

**Validation (real buttons, canonical checker).** Hull `box_hull_80x40x20-2`
+ bit `box-20mm`, bit dragged over the hull along the bed: Seat (support)
-0.18 -> `Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`,
underside 0.18 above the hull to 8e-7, liftY 20.18; Undo returns it to the
bed exactly. Align edges -> mesh y, liftY, box bottom and top `===` what Seat
left (30.380000762939453 / 20.180000762939454 / 20.380000762939453), the bit's
-Z edge flush with the hull's, X unchanged; Seat again and Align again do not
move it. Export after Align through `mesh_validate.py --json`: 40 triangles,
0 open, 0 non-manifold, volume 71360.000, 0 piercing, 0 coplanar, height
40.18, the two shells 0.1800003 apart, 3MF the same. -0.05 and 0 through the
slider each survive Align `===` (40.05 clean; 40.00 with coplanar contact).
Seat flush from the bed gives the golden plug relation and status. hinge_pip
(8 mm tall, the "held at plate level" case) seats 0.18 above the hull and
survives Align and a re-seat. Before the fix the same file fails 11 gates,
the two report lines verbatim among them.

**Known limits, stated not solved.**
- Two pieces resting side by side on the bed never seat horizontally:
  `Seat failed - corner 0 missed hull along punch axis`. Both bottoms sit on
  exactly 0.2, so the corner rays run along the hull's bottom edge and
  `NSO_rayTri` misses it. Raise the bit by any amount and the side seat
  works (measured: lifted 2, seated 0.18 off the +X wall). Outside the
  stacking report; a fix would inset the ray origins from the corners.
- A bit overhanging the hull's footprint is not raised and still fails on
  the overhanging corner, as before: the bit must sit over the target face.
