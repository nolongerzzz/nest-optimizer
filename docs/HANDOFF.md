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
  seat can express sees a different point. Used by every corner-ray site:
  the fit loop, `NSO_seatStraddle`, the residual report, and the `Flush`
  readout.
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
