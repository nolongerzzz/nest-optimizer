## Live watch - the eye button

`nso-watch.js`, one toggle next to Undo, off by default. Full write-up:
`docs/WATCH.md`. Two watchers over an ordinary session:

1. Errors, failed loads and every `setStatus` line, timestamped, with the
   refusals and stand-downs marked as such.
2. After every Undo, bake and tool switch, the rendered scene against the
   app's own logical state - `state.placed` / `state.models` /
   `modelGroup.children` / `faceMask.exclude`. A mismatch is reported the
   moment it appears as `phantom object / wall / paint / pose / footprint`,
   with the operation that preceded it, read off the app's own `pushUndo`
   type rather than guessed from a button.
3. Every selection change (`state.selectedIndex` / `state.editId`, however
   assigned) as its own event, logged before the operation that follows it;
   every operation as `preview` / `discard` / `commit` / `undo`, carrying the
   selection it acted on; build-volume warnings, which `app-fit.js` now
   routes through `setStatus` when they change. The brush announces its
   preview's two ends as a `nso:op` DOM event.
4. The history is kept in `localStorage` (`nso.watch.store`), one run per
   start, across reloads, and browsed in an in-app **Report** view - no
   download, no backend.
5. It follows into G-scope, and G-scope's own actions - in and out, legend
   rows, Detected rows, Normal / Slice switches, 3D-view clicks (and what was
   hit), every other control - are `gscope` lines of their own, in order;
   every event carries the view it happened in. Record only, no checks.

Two things about it that must not be "tidied up":

- **It never repairs what it finds.** No bake, no repaint, no undo of its own.
  A watcher that fixes a mismatch destroys the evidence it exists to capture.
- **It re-derives nothing.** Pose comes from `applyMeshRotation()`, the bed
  from `settlePlacedOnBed()`, the footprint from `meshLocalBox3()`, the paint
  from `nsoMaskCount()` and the overlay object's own identity. A second,
  drifting copy of those rules would rot into false alarms, which is the one
  failure mode that makes a watcher worthless.

`npm run watch:test` (109 checks, real app in headless Chromium), in `npm test`.
Half of it asserts an ordinary session - load, clone, move, rotate, flip, tip,
raise, cutter, split, join, paint, x-ray, undo, clear, and Measure / Check
piece / Surface grid / Select / Brush / Carve / the two locks switched on and
off again - raises **zero** findings. The other half reproduces the three bugs below and asserts they are
caught, named and timestamped.

### Three found on its first run - open, not fixed

This ticket is the watcher, not the repairs. Each check fails loudly if its
bug is fixed, which is the cue to retire the check with the fix.

1. **The `app-finish.js` bakes lose the placed pose - the other half of the
   thread `nso_pose_after_bake_test.js` closed.** That gate covers
   `NSO_sculptCommitRaw`, which now calls `applyMeshRotation` and passes clean
   here. `applyMeshRotation` still occurs nowhere in `app-finish.js`: its six
   commit sites - `sealSelectedModel`, `solidifySelectedModel`,
   `thickenSelectedModel`, `commitSoften`, `applyCapOnFace`,
   `capSelectedOpenFaces` - rebuild the placed mesh at
   `mesh.position.set(px, m.size.y / 2 + 0.3, pz)` with no rotation, and so
   does the shared bake-undo branch at `app-core.js:419`. Measured on a yawed
   `box_hull_80x40x20-2`: Seal, Solidify and Thicken out each raise it; Cap
   and Soften need a pick or an open face and were read, not driven. `width` /
   `depth` then come from the unrotated `m.size`, so the packer reserves the
   wrong footprint as well.
2. **Paint outlives the geometry it was drawn from.** `nsoMaskRepaint()` is
   called from exactly two commits, `commitSoften` and `NSO_sculptCommitRaw`.
   Seal, Solidify, Thicken and Cap replace the mesh without it, so the yellow
   is triangles copied off a mesh that is gone. Turning a painted piece
   strands it the same way - the overlay is a sibling of the piece mesh and
   `applyMeshRotation()` does not move it.
3. **Undoing a delete brings back the piece but not its model.**
   `deleteSelectedPlaced()` drops the model from `state.models` when it was
   the last instance, but pushes only a `removePlaced` entry. Undo restores a
   piece whose `sourceId` is not in the registry - absent from the Library
   list, unreachable by `getActiveModel()`, so Cut / Finish / Join have
   nothing to work on - and the rebuilt mesh carries no `userData.sourceId`
   at all.

PAINT SCOPE: **not applicable** - it reads the skip list and bakes nothing, so
it takes no row in the roster. `nsoMaskCount()` is an input to a check, never a
gate on an operation.



**Paint display and commit attribution (2026-09-24, driver-testing round 2,
Seat + paint).** All four found by driving Seat with painted pieces; Seat's
own gap and paint-scope rules held throughout (0.180 mm by the checker; Seat
here stands down on a painted B that must turn, seats when only A is painted).
- `app-mask.js`: the yellow's position / rotation / quaternion / scale are
  the piece's own objects (`Object.defineProperties` in `buildOverlay`), so a
  drag, nudge, turn or Seat carries it - it used to stay on the plate where
  the piece was painted. And `sync()` (every frame, and in the bubble phase of
  every click / pointerup / keyup / change) repaints through
  `window.nsoMaskRepaint` whenever the active piece, its mesh or its geometry
  changed since the last repaint - the ~40 direct `editId` /
  `selectedIndex` writes (Join's slot picks among them) and bakes that swap
  geometry used to leave the previous yellow up. This retires watch:test B2
  (Seal / turn on a painted piece) as FIXED, per that file's own rule.
- `app-mask.js` status lines name the piece: `Paint cleared on "<name>"`
  (inside a Join, Clear acts on the ACTIVE piece A even while B is
  highlighted, and now says so when B's paint is left alone), and a paint
  click on a piece that is not the active one says the yellow is not drawn
  for it instead of "(0 tris yellow)".
- `nso-watch.js`: a commit is logged against the piece its undo entry names
  (`modelId`, or the plate slot `index`), with `- not the selected piece` /
  `- not the active piece` when that differs; `detail.target` carries it. A
  press on the 3D view is its own operation label (`press on the 3D view`),
  so paint / Seat here / drag commits no longer carry the last button.
`npm run watch:test` part G drives all of it; every new check fails on the
code before this change.

**Panel placement and collapse (2026-09-24, driver-testing round 1).** At a
1024 x 768 pane the expanded log covered the Undo button and the Scale card's
"Scale by" row, so a person with Watch on could not click them. The panel now
starts at `left: 64px`, clear of the left tool rail (Undo and the eye stay
clickable even expanded), and the header has a collapse button (▾ / ▸) that
shrinks it to the header bar - phantom / error pills still visible, logging
unchanged. `NSOWatch.collapse(bool)` / `isCollapsed()`; the choice is a
per-viewer preference in its own localStorage key, `nso.watch.collapsed`.
`npm run watch:test` part F.

**The panel follows into G-scope (2026-09-28, driver round).** Armed on main,
the whole panel vanished the instant G-scope opened, in Normal and Slice view.
The watcher was still running - every patch is on globals G-scope shares -
but the panel lived in `.viewport-section`, under G-scope's full-screen
`#microscope` sheet (`position: fixed`, `z-index: 2000`). While on, a
`MutationObserver` on the sheet's `hidden` attribute now moves the panel and
the Report view into `#ms-viewport` when G-scope opens and back when it
closes: same instance, same run, same counts, no re-arm. Installed by
`start()`, removed by `stop()`: a watch left off is not started, shown or
moved on the way in. `NSOWatch.where()` -> `'main'` / `'gscope'`.
Branch `claude/gscope-watch-carry`. `npm run gcode:gscope-watch` (38 checks,
real clicks: arm on main, G-scope Normal + Slice, a pose phantom and an error
raised inside G-scope counted there and still on the pills back on main; and
never-armed stays off, unpatched, through both views). Fails on the code
before this change at "the panel is in G-scope's viewport". `nso-watch.js` is
untagged, so no `?v=` question. **Not added (standing rule, ask first):**
G-scope-specific logging - rows for its legend / 3D-view clicks, or a check of
a slice's rendered layers against `NSO_Slicer`'s result (the "phantom layers"
seen on the plate). Proposed in the PR; nothing in the watcher checks slice
rendering today.
