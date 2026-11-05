## undo-dispose-seal - Seal -> Undo no longer leaks 2 geometries a cycle (2026-10-26)

**The leak.** perf-bisect's `bake+undo` cycle (the real Seal button, then Undo) added **2 renderer geometries per
cycle** (15 / 17 / 19 at cycles 1 / 2 / 3). Same mechanism as [undo-dispose-yaw](undo-dispose-yaw.md): three.js keeps a
geometry's GPU buffers and attribute bindings until `dispose()`, and nothing disposed these two:

1. **The geometry Seal replaced.** `sealSelectedModel` pushes an undo entry holding a *clone* of `m.geometry`
   (`prevGeometry`), swaps a new geometry onto the model, the piece and a fresh mesh, and the geometry that was on screen
   was simply dropped. Every Seal orphaned one.
2. **The geometry a new action dropped off the redo line.** Undo puts the clone back and parks the sealed geometry on the
   redo item's plate snapshot (correct: Redo puts back the same geometry). The next Seal's `pushUndo` empties the redo
   line, but `nsoLeavingGeometries` only named pose bakes, so the sealed geometry left the stacks undisposed.

**The fix** reuses the lifecycle as it stands (app-core.js, "GEOMETRY LIFECYCLE"; `nsoReleaseGeometries` is unchanged):

- `sealSelectedModel` (app-finish.js) collects what the piece showed before the swap (`m.geometry`,
  `placedEntry.geometry`, `placedEntry.mesh.geometry`) and calls `nsoReleaseGeometries` on it once the new mesh is in
  place and the entry is on the stack. Anything a `poseHome`, another piece, the scene or an entry still names is kept.
- `nsoPoseBakeGeometries(entry, geoOf, geoOfModel)` names a `sealReplace` entry's `prevGeometry` and what it put on the
  piece, found **by model id**: `geoOfModel(modelId)` reads the redo item's plate snapshot (`post.models[].fields.geometry`,
  `post.placed[].geo` / `.fields.geometry`, matched on `sourceId`), or for `undoLastDiscard` the live model and piece.
  Every exit in the yaw note's table (a new action, `UNDO_MAX` trims, `clearRedo`, `clearUndo`, a non-redoable Undo,
  a discard) therefore releases Seals as well as pose bakes. Undo itself still disposes nothing.

**Numbers** (`npm run perf:bisect -- --head <rev> --commits <rev> --kinds bake+undo --probes load,leaks`, the real Seal
button, headless software GL, the tool's 1,000,000-triangle stand-in sphere; ~135 s a cycle, so 3 cycles each; the
figure is the renderer's geometry count after each cycle):

| cycle | before (91d557a) | after (c166447) |
|---|---|---|
| 1 | 15 | 14 |
| 2 | 17 | 14 |
| 3 | 19 | 14 |

Heap read 299.3 -> 299.5 MB before and 299.2 -> 299.5 MB after: on this probe the heap did not move either way, so the
geometry count is the signal here. (The yaw note's ~69 MB a cycle is a bake of the full 1M-triangle mesh; what a Seal
of a real piece costs per cycle was not measured.)

**Gate.** `undo:dispose` gate 12 (`a` ... `j`), Node only. `seal(P)` in the test is `sealSelectedModel`'s bookkeeping (a
clone in the entry, a new geometry on model / piece / fresh mesh, then the release), run against the real `pushUndo`,
`undoLast`, `redoLast`, `undoLastDiscard`, `clearRedo` and the world snapshot / restore. It checks: the swap disposes
the replaced geometry once and nothing else; Undo disposes nothing (Redo returns the same geometry); a new Seal after
Undo disposes the redo line's geometry and the clone it replaces; ten Seal -> Undo cycles leave the one on screen and
the one on the redo line; `clearRedo`, `undoLastDiscard`, a non-redoable Undo and an `UNDO_MAX` trim each dispose what
only they named; never a geometry another piece draws or a `poseHome` names. 12j reads the real call site in
app-finish.js (the release comes after the swap) because the vm cannot run `sealSelectedModel`. Break checks: with
app-core.js as it was, seven checks fail (12b, 12c twice, 12e, 12f, 12g, 12h); with the release line gone from the
call site, 12j fails.

**Not done here.**
- The other ops in `UNDO_REPLACE_LABEL` (Soften, Cap, Solidify, Thicken, Carve, Punch, ...) swap a geometry the same
  way and very probably leak it the same way; four call sites in app-finish.js clone `prevGeometry` as Seal does. Each
  op needs its call site to release what it replaced and its type added next to `sealReplace` in
  `nsoPoseBakeGeometries`; the holder scan keeps anything still named, so it is a row and a call, not a new mechanism.
  Not measured, so not claimed.
- `app.js` (the 9,900-line file) is not loaded by `index.html` and carries its own stale `sealSelectedModel`; it was not
  touched.
