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
