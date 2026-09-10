# CLAUDE.md — Nest Optimizer (surface branch)

Read this once. Do not ask the user to restate it.

## Repo
- Live: https://nolongerzzz.github.io/nest-optimizer/
- Repo: github.com/nolongerzzz/nest-optimizer
- This branch: `claude-wip-surface-features` only.
- Do not commit to `main`. Do not commit to `claude-wip`.

## What this branch may build
In order. One feature at a time. Commit at each boundary.

1. Slide-on-surface placement of an already-cloned piece (stick to a picked face; snap back if the pose is invalid).
2. Data-only library of surface stamps / textures. Adding an entry must not change placement code.
3. Visual / UV wrap + single stamp. Triangle soup must be byte-identical after. If geometry must change, stop and flag.

## What already exists — do not rebuild
- Clone piece + count (Library).
- Free plate drag, orbit-on-plate, 2 mm nudge, Tip / Edge / Flat / Pitch / Bank.
- Split, Join, Align, Subtract, Seat, Extract bit, Seal, Repair, Solidify, Thicken.
- Finish wrap: Corners, Corners+edges, Round, Bevel. Full wrap checkbox. Paint faces (yellow = skip). mask5 KEEP.

## Files you may touch
New small scripts you add, plus the minimum hook in `index.html` / `styles.css` / `app-ux.js` to arm a new tool.

## Files you must not edit
- `app-cut.js`
- `app-finish.js`
- `app-join.js`
- `app-mask.js`
- `app-core.js` (except a one-line hook if slide must see `state.placed`)
- `stampHud()` in `app-ux.js`
- Any `?v=` cache tag and the HUD string. Those belong to the other track.

There is no live monolith. `app.js` still exists as a leftover. Do not edit it. Do not load it. Do not create another one.

## Stack
- Three.js r147 from the existing CDN tags.
- Classic `<script>` tags. No ES modules. No bundler. No npm build.
- GitHub Pages static only.
- Safari must work.

## Geometry rules
- Soup = flat array, 9 floats per triangle.
- Split caps stay flat. Rounding is Finish, never inside Split.
- Do not nest fillet inside `splitBothSides`.
- Do not replace or remove the CSG kernel used by Join / Subtract.
- Do not invent a second cut engine.
- Broken or torn mesh never ships. If the smart path fails, leave the piece unchanged and say why.
- New helpers: `NSO_` prefix.

## Interaction rules
- New tools arm/disarm like Paint. Nothing is pre-selected.
- Do not steal left-drag from plate orbit or free piece move unless your tool is armed.
- Clone-on-surface copies the current baked mesh, not a hidden unrounded source. Say that in status if it matters.

## Test
- Default brick: `fixtures/box-20mm.stl` until the owner names another file.
- If a change can alter triangle soup, export an STL and run:
  `python3 tools/stl_watertight_check.py path/to/export.stl --odd --degen`
  Required: exit 0, `odd_edges(count!=2)` = 0, `degenerate_tris` = 0.
- Feature 3 (UV wrap) must not change soup. If it does, stop. Do not "repair" it on this branch.
- Owner review is the **end of the run**, not per feature while they sleep. Commit each feature with the check output in the commit message. They KEEP or FAIL in the morning.
- Do not claim watertight from the viewport.

## How to work
- State what you will and will not touch before coding.
- Additive only. No refactors "while you are in there."
- If feature 1 needs cut / wrap / join / mask internals, stop.
- No merge to main. Owner + the other track decide that.
- If asked for a full script dump, refuse. Commit on this branch instead.
- Ping-pong mask/finish tickets live on `claude-wip`. Ignore them. Do not implement mask6 here.
