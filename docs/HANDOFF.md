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
`export3MF` block) and `app-join.js` (the button), behind **Export plate 3MF**
in the Export card. Full write-up: `docs/baked-cooling-settings.md`.

Unlike repair / sculpt / planar fuse, this one **is** wired in.

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

Still open: nobody has opened one of these in a real Bambu Studio instance, and
the `=` vs `:` separator in the source file has not been eyeballed (NSO writes
JSON - see the doc's "Not yet verified").

Out of scope here: the Grispr G-code post-processing path for multi-material.

## 3MF checks
`npm run 3mf:roundtrip` is the dependency-free suite (56 checks): it exports a
real `.3mf` and reads it back with an independent ZIP reader, asserting key set,
key order, array-of-string shape, byte-exact values including `%`, raw text
form, determinism, and that the format guard rejects bad values.
`npm run 3mf:drive` (38 checks) drives the real app in headless Chromium -
fixture import, Optimize, the actual **Export plate 3MF** click, the real
download - then takes the saved file apart. Both are in `npm test`. Like the CTH
browser checks, the drive serves three from devDependencies, not the CDN. On a
runner whose Chromium predates the installed Playwright, set `CHROME_PATH`.

## Grispr - per-object fan control (G-code post-process, NOT wired in)

`tools/grispr/grispr.py`, standalone Python 3, stdlib only. Full write-up:
`tools/grispr/README.md`. Suite: `npm run grispr:test` (65 tests, 14 synthetic
fixtures, plus 60 randomised layouts). Deliberately not in `npm test` - like
repair / sculpt / planar fuse it is unwired, and `npm test` is all-node today.

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

This plate is SINGLE object, so it cannot exercise the interleaved
multi-object case that is the whole point of the module - that still rests on
fixtures. It also has `exclude_object = 1` yet emits no start/stop markers and
no `M624`/`M625`, which suggests Bambu only emits the labelling machinery for
plates with more than one object. If that holds, real multi-object plates land
in label mode and never need the inference. Decisive test is cheap: slice a
2-object plate and `grep -c 'start printing object'`.

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

## Plate reference grid + grid-snap (landed, `app-core.js`)

Full write-up with numbers: `docs/PLATE-GRID.md`. Suite: `npm run grid:plate`
(`tools/nso_plate_grid_test.js`), added to the `test` chain so CI gates it.
Branch: `claude-wip-plate-grid`. No `?v=` tag bumped — Grok owns those.

A flat, world-aligned grid owned by the build plate, plus an optional soft snap
on the same lattice. Controls in the Plate card: `#plate-grid-show`
(auto / on / off, default auto) and `#chk-plate-grid-snap` (default off).

Three things the next ticket should not re-derive:

1. **Two grids now, and they are different features.** The surface grid
   (`app-seat-grid.js`, `b0dc10d`) draws on the Join/Seat target piece; this one
   is the bed. At the tip this branched from (`2a6d07a`) the surface grid did
   not exist, so the audit found no pattern to copy and the modes here were
   designed from the ticket; it landed in parallel and the two converged anyway
   — both carry `['auto','on','off']` and both kill picking with a `raycast`
   no-op. Naming is what the merge had to settle: `state.seatGridMode` and
   `#btn-seat-grid` for the surface grid, `state.plateGridMode` /
   `state.plateGridSnap` and `#plate-grid-show` / `#chk-plate-grid-snap` for the
   plate. Suites: `grid:math` + `grid:wire` are the surface grid's,
   `grid:plate` (`tools/nso_plate_grid_test.js`) is this one's. They share no
   code, and the surface grid was not touched.
2. **The old `plateGrid` was a `THREE.GridHelper` and is gone.** Same state
   slot, same name, same lifecycle in `buildPlateMesh` — but it was square at
   `max(w, d)` (overhanging a Prusa bed by 40 mm), had no round mm spacing to
   snap to (14.22 mm on an A1 256), and was a `hitPlateSurface` pick target.
   It is now an owned `Group` of two `LineSegments`, clipped to the real plate,
   on a 10 mm lattice, and removed from the pick list. `plateMesh` covers the
   same footprint so plate-drag orbit is unaffected.
3. **`PLATE_GRID_SNAP_STRENGTH` must stay below 1.** The snap maps the cursor offset
   `d` from the nearest line through `f(d) = R((1-S)u + Su²)`, `u = |d|/R`. The
   slope is `>= 1-S`, so `S < 1` is what makes the mapping strictly increasing —
   which is what makes this an assist you can always drag out of rather than a
   lock. At `S = 1` the slope at the line becomes 0 and it locks. The suite
   measures monotonicity on a real 41-sample drag sweep, so raising `S` to 1
   fails `npm test` rather than shipping a lock.

Paint: not applicable. The standing rule binds bake mechanisms; this draws lines
and moves a placement coordinate, and touches no triangle. Stated in
`docs/PLATE-GRID.md` §4 so the category question is answered once.

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

## Size — scale a piece to a real dimension (landed, `app-scale.js`)

Added 2026-09-17. The audit that preceded it is the short version of why the
file exists: **there was no scale control of any kind** on `claude-wip` — not a
dimension box, not a factor box. Every occurrence of "scale" in the wired app
was camera zoom (`onViewportWheel`), a `mesh.scale.copy` in the mask overlay, or
a three.js `addScaledVector`/`multiplyScalar`. A piece's size came from its file,
and only Cut, Thicken, Solidify and the Finish bakes moved it. So "make this
exactly 50 mm tall" had no answer at all, and neither did "half size".

The Size card in the left panel now has both, and the first is the point:

- **Set size** — pick X, Height, Z or *Longest edge*, type the mm, press. The
  factor is solved for you and applied to all three axes.
- **Scale by** — the plain uniform multiplier, which is the primitive the first
  one is built on.

**Uniform only, deliberately.** "50 mm tall" on a part means the part at 50 mm,
not a part squashed on one axis. Non-uniform scale moves wall thicknesses, hole
roundness and overhang angles independently, and nothing downstream expects it —
not Cut's raw mapping, not the packer's footprint, not Soften's radius. A
per-axis stretch would be a different feature with a different name.

**Paint wins, whole-piece.** A uniform scale moves every vertex and there is no
sub-region to scope the check to, so by the scoping rule above any painted face
stands the whole operation down, naming the count — the same answer Smooth
gives. Worth recording why this is not just inherited: a mask entry is a plane
`{n, d}`, and under a uniform scale about the bbox centre `n` is unchanged while
`d` scales, so the paint *could* be carried through arithmetically. Doing so
would be a second mapping from a plane back to a face, which is exactly the
re-derivation the standing rule forbids. Until the mask stores something
scale-invariant, refusing is the honest answer.

**Exactly, and what "exactly" can mean.** The soup is a `Float32Array` and stays
one, so the span the file carries is a difference of two 24-bit mantissas. On
every fixture measured the result lands on the nearest float32 to the requested
millimetre — for 12.7 mm that is 12.699999809265137, off by 1.91e-7 mm, which is
`|float32(12.7) - 12.7|` and irreducible by any factor. `NSO_scaleSolve` keeps a
correction loop (`f *= target / measured`, always re-derived from the original
soup so error cannot compound, best result kept). It is measured, not assumed:
over 200,000 random (offset, extent, target) triples, **8,660 improved, 0
worsened, 191,340 unchanged**, best gain 2.3e-4 mm. The unchanged majority is
the easy case — a piece near the origin. The 4% that improve are meshes whose
coordinates sit far from the origin, i.e. any STL exported without recentring,
where both ends of the span round on a much coarser grid than the span itself.
`tools/nso_wire_scale_test.js` section 8b reproduces one (2.36e-4 → 8.52e-6 mm,
27.6× closer, two passes).

**Do not gate this with `NSO_edgeStats`.** That welder quantises on a FIXED 1e-4
mm grid, which is correct for a bake that leaves the piece the same size and
wrong for one that does not: scale a sound mesh up by 10 and two vertices that
shared a grid cell no longer do, so it reads as newly open; scale a torn one
down and they merge, so it reads as freshly healed. Neither is a fact about the
mesh. `NSO_scaleTopoStats(soup, q, areaEps)` takes the quantisation from the
caller, and `NSO_scaleGate` hands the after-mesh `q / factor` and
`areaEps * factor²`, so the two measurements are of the same shape at the same
relative tolerance and any difference is real. It compares triangles, distinct
vertices, distinct edges, open edges, non-manifold edges and degenerate
triangles; the gate runs before anything is committed.

**Guard rails.** Factor must land in 1e-4..1e4, and the result must be at least
0.1 mm on its shortest axis — the same floor `addModel` uses to call a loaded
mesh empty, so a scale can never produce a piece the loader would reject. Every
refusal leaves the piece byte-for-byte unchanged.

### `npm run wire:scale` — in `npm test`, so CI gates it

`tools/nso_wire_scale_test.js` drives the real app in headless Chromium, then
measures the **file**, not the app's opinion of itself: it reads the piece's soup
back out of the page, writes a binary STL with `tools/nso_stl_io.js`, and runs
the canonical checker — `python3 tools/stl_watertight_check.py <f> --odd --degen`
— on the before and after copies. Eleven sections; 80x40x20 box and
`fixture_sphere_curved.stl`, both axis targets and longest-edge targets, the
factor button, undo (bit-for-bit restore), eight refusals, and the painted
stand-down.

**Negative-controlled (section 4b), because a green checker run means nothing if
red is unreachable.** One vertex of the scaled result is nudged 1 mm and the
same checker command turns red — `open_edges 0 → 4, odd_edges 0 → 4, FAIL odd
edges` — while the untouched result stays OK. The app's own gate gets the same
treatment: `NSO_scaleGate` is handed that torn soup and refuses it
(`distinct vertices changed 16->17`), so the gate is live rather than
decorative.
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


## Seat refuses a bit the target face cuts through (2026-09-17)
`app-join.js` `NSO_seatStraddle` / `NSO_SEAT_STRADDLE_TOL` and one gate inside
`NSO_seatFlushBitToHull`. Check: `npm run seat:overhang`
(`tools/nso_seat_overhang_test.js`, in `npm test`, 44 gates). Found beside the
local-carve audit, not reported from the bed: a bit sitting ACROSS a hull wall
seats "successfully", and the seat eats every millimetre that stood proud.

**The defect, measured.** Hull `box_hull_80x40x20-2` (80 x 40, 20 tall),
bit `hinge_knuckle_box` (18 x 8 x 8), the bit put across the hull's +X wall at
mid-height: 6 mm of it proud of `x = 40`, the other 12 mm already inside the
hull. Seat flush returns `Seated - proud 0.01mm, skin error 0.00mm - Subtract`
and leaves the bit at `x 22.01 .. 40.01` - the 6 mm driven to 0.01 mm and the
whole bit buried as a plug through that face, with no warning anywhere. Seat
(support) at -0.18 takes the same pose and teleports the bit 12 mm the other
way, out of the hull, and also says `Seated`.

Why it was reachable and why it survived every earlier suite: the fit refuses
as soon as a corner ray misses (`corner N missed hull along punch axis`), and
over the hull's TOP face a straddling bit always has a corner in the air, or
else its footprint is inside the hull's and `NSO_raiseBuriedBitClear` lifts it
clear first. A vertical WALL is different - it can shadow all four corner rays
at once, and nothing raises a bit sideways. The same bit 7 mm higher (2 of 4
rays miss) and at the vertical edge (1 of 4) refuse exactly as they always
did, so the shipped behaviour flipped between "refuse" and "swallow the bit"
across a 7 mm move. Neither the Seat-gap nor the Seat-align fixture pair can
reach the pose at all: a 20 mm cube against a 20 mm wall always has two
corners off the wall, which is why both suites pass on the defect.

**Fix.** `NSO_seatStraddle` (pure; the seat calls it once, on the pose it was
given, before the tips probe and the fit). It casts the fit's own four corner
rays and compares each hit with the bit's depth along the punch axis: `d >=
depth` everywhere means the bit is clear of the face and approaches it (the
staged plug, the raised bit, the side seat); `d <= 0` everywhere means it is
wholly inside (a plug being re-seated). In between, the face cuts through the
bit, and the seat refuses with the millimetres at stake:
`Seat failed - bit straddles that hull face - 6.00mm of it stands proud and
the rest is already inside. Move it clear of the face (or fully inside) and
seat again`. Nothing is moved - both buttons already restore the bit on a
refused seat, and the plate export is byte-identical across the click.
`NSO_SEAT_STRADDLE_TOL` is 0.1 mm, so the 0.01 mm a flush seat leaves standing
proud and the 0.05 mm the gap slider's overlap end pushes in are the seat's own
handiwork, not an overhang: seating twice in a row still lands `===`.

**Validation** (`tools/nso_seat_overhang_test.js`, real buttons and the
canonical checker). The reported case refused by both buttons, the bit's
position / quaternion / x / z / liftY and the exported plate STL identical
across the click, and the same placement with the guard stubbed out still
producing the shipped 6 mm -> 0.01 mm burial, so the gate cannot pass
vacuously. A 504-placement sweep - four walls x seven heights x nine depths,
both modes - with 185 seats, 176 straddle refusals and 143 missed-corner
refusals: no placement seats while the face cuts through the bit, every
refusal restores the pose exactly, and the probe moves nothing. Untouched:
the Seat-gap golden flush pose and status to 1e-9, a flush seat repeated,
the side plug (a bit clear of the wall driven in to 0.01 proud), the buried
plug pulled back out, the locked -0.18 easy-release seat with its export
through `tools/mesh_validate.py --json` (watertight, 0 piercing, 0 coplanar,
two shells 0.18 mm apart), +0.05 and 0 re-seated from their own results, and a
-0.18 gap seat against a wall. `npm run seat:gap` and `npm run seat:align`
unchanged. Every `npm test` step ran green here except the four that launch
Playwright's own default browser build (`cth-test/capture-check.mjs`,
`cth-test/drive-check.mjs` and the two `3mf-test` drive checks): this sandbox
ships a Chromium that build does not match, and they fail the same way on a
clean tree. The suites that matter here all go through
`tools/nso_app_harness.js`, which picks the Chromium that is on disk.

**Known limits, stated not solved.**
- A bit that straddles is refused, not rescued. The vertical case has
  `NSO_raiseBuriedBitClear` to lift a buried bit clear and seat it from above;
  there is no sideways equivalent, and inventing one would move a piece in XZ,
  which is the user's own placement. The message says which way to move it.
- Clicking Seat flush a second time on a SIDE plug refuses with `corner 0
  missed hull along punch axis`, with this guard and without it:
  `NSO_raiseBuriedBitClear` counts the seated plug as buried (its footprint is
  inside the hull's to the 0.05 mm pad its 0.01-proud face now sits within),
  lifts it above the hull's TOP, and the corner just past the top face's edge
  misses. Older than this work, untouched by it, and pinned at the core where
  the re-seat does hold.
- The straddle gate reads the bit's box corners, like the fit it guards. A bit
  whose silhouette is much smaller than its box can have all four corner rays
  clear of the hull while the body is not; that is the fit's own assumption,
  not something this gate narrows.


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
- ~~Two pieces resting side by side on the bed never seat horizontally:
  `Seat failed - corner 0 missed hull along punch axis`.~~ **Fixed
  2026-09-17** - the ray origins are inset, see "Seating side by side" below.
  The reading here was right: both bottoms sit on the same bed baseline, so
  the corner rays ran along the hull's bottom edge and `NSO_rayTri` missed
  it; raising the bit by any amount already worked.
- A bit overhanging the hull's footprint is not raised and still fails on
  the overhanging corner, as before: the bit must sit over the target face.


## Seating side by side - the corner rays are inset (2026-09-17)
`app-join.js` `NSO_SEAT_RAY_INSET` / `NSO_seatRayOrigins` (every corner ray in
the seat now leaves from those origins), and `NSO_SEAT_BED_EPS` in
`seatBitAtGap`'s lift clamp. Check: `npm run seat:side`
(`tools/nso_seat_side_test.js`, in `npm test`, 52 gates). This closes the
limit the vertical-stacking work stated and did not solve: "Two pieces resting
side by side on the bed never seat horizontally - `Seat failed - corner 0
missed hull along punch axis`."

**Audit first (Task 1), and the reading it confirmed.** The limit's own
diagnosis held up against the code, and the numbers are these. Hull
`box_hull_80x40x20-2` settled on the bed (`0.2 .. 20.2`), `box-20mm` dragged
beside it 3 mm off the `+X` wall: the plug frame picks `+X`, and the four rays
leave the bit's `+X` face corners along `-X`. The two at `y = 20.2` hit the
wall at `x = 40`, `d = 23`. The two at the bit's bottom do not. Both bottoms
are on the bed baseline by construction - `settlePlacedOnBed` puts every
world-box bottom on `0.2 + liftY` - so those rays travel *along* the hull's
bottom edge, where `NSO_rayTri` needs a strictly interior barycentric hit and
the graze measures ~1e-9 of the wrong sign. The fit refuses on the first one.

Swept through the real app: 60 side-by-side placements (four walls x five
distances from the wall, `0 / 0.18 / 1 / 3 / 10` mm, x three slides along it).
**All 60 lose at least one corner ray with the origin at the corner**, at an
inset of 1e-9 too. At 1e-7 and above, 50 of them recover all four; the other
10 are the slides that hang 3 mm past the hull's own `+Z` edge, and they keep
missing at every inset out to 0.01 mm - a bit that overhangs the target face
must still refuse, and it does. No recovered ray reports the far side of the
hull: every one measures the near wall, `d = 20 + the staged distance`, exact
to 1e-6.

**False-positive straddle - the thing to get wrong.** The overhang gate
(`NSO_seatStraddle`, "Seat refuses a bit the target face cuts through") reads
the same four rays and skips itself entirely when one misses (`if (!h) return
null`). So the rays could not be fixed in the fit alone: the fit would seat a
bed-level straddle the gate had just been blinded to. Both read the inset
origins now, and per the gate's own arithmetic a side-by-side pose can never
read as a straddle - a corner cut needs `off + 0.1 < d < depth - 0.1`, and a
bit that stands clear of the wall has `d = depth + its distance from it`.
Measured, not just argued: 0 straddle flags across all 60 placements at every
inset from 0 to 0.01 mm, and the overhang suite's own 504-placement sweep
returns the same counts as before this change - 185 seated, 176 straddle
refusals, 143 missed-corner refusals. What did change is the bed-level
straddle the gate used to lose: 6 mm of the bit proud of the `+X` wall on the
bed now refuses by name instead of by missed corner.

**Fix.**
- `NSO_seatRayOrigins(corners)` pulls each ray origin `NSO_SEAT_RAY_INSET`
  (0.001 mm) along the face's own diagonal toward the face centre - a fraction
  of the way, never a fixed step, so a sub-millimetre bit still samples inside
  its own face. The offset is in the face plane, which is perpendicular to the
  punch axis, so every measured `d` is unchanged: pinned at 1e-12. One micron
  is ~100x the Float32 vertex noise a plate-sized coordinate carries and 1/100
  of `NSO_SEAT_STRADDLE_TOL`, 1/10 of the gap slider's step - no offset the
  seat can express sees a different point. Used by all five corner-ray sites:
  the fit loop, `NSO_seatStraddle`, `NSO_seatTipsProbe`, the residual report,
  and the `Flush` readout.
- `NSO_SEAT_BED_EPS` (1e-6) in `seatBitAtGap`. A horizontal seat never changes
  the bit's height, so a settled bit comes back with `liftY = -1e-16` and the
  old `if (lift < 0)` appended "bit would sink below the plate, held at plate
  level: gap NOT as requested" to a seat that had done exactly what was asked.
  The clamp to 0 stays; only the warning now needs a real sink.

**Validation** (`tools/nso_seat_side_test.js`, real buttons and the canonical
checker). The staging is asserted to be the grazing one (both world-box
bottoms `===`). With `NSO_seatRayOrigins` stubbed back to the bare corners the
same click reproduces `Seat failed - corner 0 missed hull along punch axis`
and moves nothing, so the gates cannot pass vacuously. Seat (support) at
-0.18: `Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`,
mating face 0.18 off the wall, the bit still on the bed (bottom `===` the
hull's, `liftY` 0), Z, mesh y and the quaternion untouched, one undo entry,
re-seat and Undo both `===`. The export through `tools/mesh_validate.py
--json`: 40 triangles, 0 open, 0 non-manifold, volume 71360.000 (hull + bit),
0 piercing, 0 coplanar, width 100.18, height 20, two shells 0.1800003 apart
along X, both on z = 0. -0.05 and 0 through the slider with their own export
signatures (0 gives coplanar contact, as it does stacking). All four walls
seat, each moving the bit along that axis only. Seat flush side by side gives
the side plug, outer face 0.01 proud. A 6 mm bed-level straddle is refused by
both buttons with the pose and the plate export identical across the click.
The clamp: a stubbed 1e-9 drop seats clean, a stubbed 1 mm drop still warns.
`npm run seat:gap`, `npm run seat:align` and `npm run seat:overhang` are
unchanged, golden poses and counts included.

**Known limits, stated not solved.**
- A bit that overhangs the target face still refuses on the overhanging
  corner. The inset is a micron; it rescues a graze, never a real overhang,
  and the sweep pins that at 10 placements out to a 0.01 mm inset.
- The seat still samples the hull at four points. A hull feature between them
  is invisible to the fit, inset or not - that is the corner-ray fit's own
  assumption, unchanged here.
- Gap 0 side by side exports coplanar contact, exactly as gap 0 does when
  stacking: two shells touching, which the canonical checker counts.


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

**Through the real app** (test part 3): plain block A + box-20mm B, Seat 0 on
the flat A -> `reference 'plane'`; Skin face -> A's raw soup replaced, 8.6
tall, undo restores 12 tris; painted +Z stands down, paint on -Z does not;
sphere refused; Seat 0 on the skinned A -> B's underside on A's world top to
2e-6, hull height 8.6 (not 8), status names the tips, core `tipRise` 0.600,
`gapAchieved` 0; Seat -0.18 -> plate export 2 shells 0.18 apart, 0 piercing,
0 coplanar, height 28.78; Seat +0.05 -> 0.05 into the relief.

## Seat here - seating against a curved or irregular target (2026-09-18)
`nso_seat_surface.js` (new: the pure core, browser + Node),
`app-seat-surface.js` (new: the **Seat here** button, an armed click in the
Join card), `tools/nso_soup_distance.js` (new: the independent
minimum-distance checker), plus small additive changes to `app-core.js` (the
undo label, `prevPose` on the replace-undo branch, the click question),
`app-measure.js` and `app-carve.js` (disarm each other), `index.html`,
`styles.css`. Full write-up: `docs/SEAT-SURFACE.md`.

Checks: `npm run seat:curved-audit` (`tools/nso_seat_curved_audit.js`, Task
1's audit, exit 0 = every finding still holds), `npm run seat:surface`
(`tools/nso_seat_surface_test.js`, the gate), `npm run dist:selfcheck`. All
three in `npm test`. **This is the separate ticket the Texture section above
dispatched, and it answers the open question that note left open - what
`supportExtreme` and Seat mean against a curved contact. Of the two options it
offered, this is the second: Seat grew a second mode.** It is a new module and
a new button, so Texture's own gate ("neither new file calls supportExtreme,
tipContactArea or any Seat entry point") still holds, `nso_skin_band.js` and
`app-texture.js` are untouched, and a Texture band is still not offered as a
Seat target - this seat measures an interface between two pieces, and the
relief's tip surface is not one.

**Positioning only.** The SHAPE of the contact - a mating face cut to the
curve, a pad, a cup - is a separate later layer, and the boundary is measured
rather than waved at: see `docs/SEAT-SURFACE.md`, "Deferred: contact
geometry".

**Audit first, and the answer was BOTH.** The shipped seat casts four rays
from the corners of the bit's outer box face along one axis. A curved target
falls away from a flat footprint, so those corners overhang and the ray misses
- a 20 mm bit over the 20 mm sphere, a 12x8x8 bit 5 mm off the crown, anything
over the genus-1 groove and a 20 mm bit over the organic blob all refuse on
BOTH buttons with `corner N missed hull along punch axis`. Where the rays do
land, gap mode reaches the skin-tips branch and measures the right minimum -
but reports a bare sphere as `from skin tips, relief 3.11mm above the base
plane`, and writes a rotation of 0.0000 degrees, so the piece is never
oriented to the surface. `proud` mode has no tips probe at all: a rod on end
over the crown seats with a residual of 0.4754 mm against a requested 0.01.
And the footprint is the bit's BOX face, not its contact outline, so on the
blob a requested 0.18 mm air gap really measures 0.2053 (round rod: the square
over-reaches the circle) or 0.1737 (flat bit: the blob rises outside the
footprint) - both larger than the 0.05 mm easy-release window.

**The finding that decided the design.** `buildCombinedGeometry` rebuilds each
piece's rotation from the quantised pose fields and never reads
`mesh.quaternion`. Measured: a 0.3 rad tilt is 25.017 mm of scene height and
20.000 mm of exported height, every pose field still zero. So the shipped tilt
fit cannot be gated through the canonical checker at all - the file does not
carry what the screen shows. **Seat here therefore writes no free rotation.**
It rotates the piece's own raw soup by the delta in raw axes
(`Rx(+90) . Q_pose^-1 . delta . Q_pose . Rx(-90)`), commits through
`NSO_sculptCommitRaw` like every other bake, and re-fits x / z / liftY to the
world box the plan measured. That is Local-Carve's contained-pose-state
decision reached from the other side: the blade stays out of `state.placed`, a
seated piece cannot, so the pose model must never be handed anything it cannot
hold.

**What is reused, not rewritten.** `NSO_Carve.probeTarget` identifies the
feature at an arbitrary point (its dihedral merge is what reads a tessellated
dome as ONE face); `NSO_Skin.supportExtreme` measures a surface over a quad
footprint and is already orientation-agnostic; the gap sign convention and the
`#seat-gap` slider are the shipped ones - negative = air, positive =
penetration, 0 = touching.

**One thing probeTarget could not be used for.** Its outward direction is not
a tangent-accurate normal and cannot be: it buckets triangles within 5 degrees
and keeps the FIRST one's normal as the bucket's, so on a fine mesh the answer
depends on triangle order - up to 2.5 degrees off analytic on a 240x480
sphere, and no finer a mesh helps. Fine for a blade, not for a seat (2.5
degrees across a 12 mm footprint is 0.25 mm at the far edge). So the feature
comes from probeTarget and the NORMAL is measured next to it, as the true
area-weighted mean over the same neighbourhood: 0.0000-0.1825 degrees against
calculus, on a coarse mesh and a fine one alike.

**What "the gap" means, and it is solved not inferred.** `gap < 0`: the TRUE
MINIMUM DISTANCE between the two surfaces is `|gap|`. `gap = 0`: first
contact. `gap > 0`: `gap` mm past first contact. First contact is a separate,
bracketed solve because `dist(t) = 0` over a whole interval - inverting it as
if monotone is how a "touching" seat came out 0.14 mm clear and a "+0.05
overlap" 0.10 mm deep, both seen before the bracket went in. Where the contact
IS the footprint quad - every case the shipped seat was validated on - first
contact and the support plane are the same offset, so `gap` means exactly what
it meant before; where they differ, only the shape-dependent rule was ever
wrong. Measured payoff on the round rod over the blob, 16 aim points: the
support rule alone gives up to 0.6084 mm of real clearance for a requested
0.18; the solve gives 0.18000 at all sixteen.

**Two minimum-distance implementations, on purpose.** The core solves with its
own; the gates measure with `tools/nso_soup_distance.js`, stdlib-only with its
own self-check, and the suite asserts the two agree to 1e-9 on the real
fixtures. Same discipline as `tools/nso_selfint_equiv_test.js`. Both are exact
(9 edge/edge + 6 vertex/triangle, with contact tested separately), because
every Seat check before this one measured its gap as a box difference along one
axis - exact for two boxes, meaningless against a dome.

**Validation (real button, real curved fixtures, real export, canonical
checker).** Eleven aim points across the sphere (crown, equator, 45,
off-axis), the blob (top, side, off-axis) and the groove (ring top, outer
flank, dome at 45, and the CONCAVE inner wall), plus the flat block. Each:
scene clearance = the requested 0.18 to 2e-5; no free rotation on the mesh;
Export plate through `mesh_validate.py --json` with 0 open, 0 non-manifold, 0
piercing, 0 coplanar; and **the gap measured on the EXPORTED shells is 0.18 mm
to 5e-5**, 3MF the same - turns of 5.6, 23.4 and 44.5 degrees all coming out of
the file intact, which is the gate the shipped tilt fit could never pass. Euler
is asserted as the TARGET fixture's own plus the bit's 2, not a constant 4,
because `fixture_groove_concave` is genus 1. One Undo returns B to its imported
soup after every one of the eleven, so the bakes cannot stack. Plus the sign
convention through the button on the sphere's flank, ONE seat driven by a real
mouse click on the canvas, the paint stand-down and its converse, and four
app-level refusals.

**Regression: the flat-face seat is untouched.** `NSO_seatFlushBitToHull` is
byte-identical and `app-join.js` contains no reference to the new core - both
asserted. The golden flush pose (1e-9) and status line (byte for byte) and the
flat `-0.18` gap seat are re-pinned in the new suite as well as in
`tools/nso_seat_gap_test.js`, so a change to either has to fail two suites.
`seat:gap`, `seat:align`, `seat:overhang`, `seat:side` and `paint:scope` all
pass unchanged.

**Agreeing with the two threads that landed beside it.** Seat here writes the
seat record every Seat now leaves (`NSO_recordSeat`, app-join.js), so the 3MF
scene block carries its gap out to the file: `kind: 'support'`, `measured` in
the coupon sign, `reference: 'face'`, and no `residual` - there is no
corner-ray residual here and the normaliser reads a null as 0, so the key is
left absent. Gated on the piece AND through `buildPlateSceneJson`. And it
joins the one-armed-click-at-a-time rule both ways: arming it turns Center
lock's pick off, arming Center lock (or Paint, Carve, Measure) turns it off,
and `clearJoinSlots` retires it with the slot - silently, through
`nsoSeatHereDisarm`, because clicking the button there would print over the
caller's own status line. All gated.

**PAINT SCOPE: WHOLE-PIECE**, on the piece being seated, and only when the
seat has to turn it - the target is only ever read, and a seat that needs no
turn changes no geometry. A turn rewrites the whole soup in new axes, so no
sub-region survives as itself and whole-piece is the only coherent reading.
Reasoning in full: `docs/SEAT-SURFACE.md` §3.

**Known limits, stated not solved.**
- A flat face tangent to a sphere touches at ONE POINT and
  `mesh_validate.py` has no class for that, so a `gap 0` seat on a curve reads
  0 piercing / 0 coplanar exactly as an air gap does. The measured
  shell-to-shell distance (0.00000 vs 0.05000) and the piercing pairs at +0.05
  are what separate them, and the suite asserts both.
- The footprint is still the piece's box face. The solve makes that cost
  nothing in the SEPARATION; it still costs the contact-patch reporting, which
  is the deferred shape layer.
- A seat that would put the piece below the plate is refused rather than
  clamped. Clamping is what the gap seat does, and it is right there (the
  status says "gap NOT as requested"); here the whole point is that the gap is
  exact, so a pose that cannot deliver it is not offered.

## Inside corners — the corners8 setback in a pocket (landed, `nso_inside_corners.js`)

Full write-up with numbers: `docs/INSIDE-CORNERS.md`. Suite:
`node tools/nso_inside_corners_test.js` (92 checks). **Not wired in** — no
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
stands the bake down and names the face. Paint on the pocket mouth, or anywhere
on the hull, does not stop it — this treatment never reaches those. A painted
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
