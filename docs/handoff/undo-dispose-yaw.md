## undo-dispose-yaw - a pose bake's geometry is disposed when nothing reachable names it (2026-10-24)

**The leak.** A Yaw bakes the turn into a new geometry (`nsoBakePlacedPose`); Undo swaps the old one back onto the same
mesh (`nsoUndoPoseBake`) and nothing disposed the one it took off. perf-bisect's yaw + Undo cycle: +1 renderer geometry
and ~69 MB of heap per cycle on a 1,000,000-triangle piece (the owner measured ~65 MB on `ButVase.3mf`).

**What holds it (measured, not assumed).** Not `m.rawTris` and not an undo / redo entry: with a `WeakRef` on every big
geometry and every `m.rawTris`, then a forced GC, everything still alive is reachable from `state` (the piece on screen
and the one on the redo line); the rest was collected. The geometry *object* is collected too, yet its position array
stays: the renderer keeps per-geometry state (GPU buffers, the bindings holding the attribute arrays, the count in
`renderer.info.memory.geometries`) until `dispose()`. Controlled check: 8 geometries nothing in the app named, the page
holding them; `dispose()` on 4 of them, then every strong ref dropped and a GC - all 4 disposed position arrays freed, all
4 undisposed ones still alive. So it is the geometry's lifecycle, and `dispose()` is the fix.

**The rule** (app-core.js, "GEOMETRY LIFECYCLE", above `pushUndo`). A geometry is disposed exactly when nothing the user
can still reach names it. Reachable: `state.models`, `state.placed` (piece, mesh, `p.geometry`, `p.poseHome.geometry`),
the scene, every entry on `state.undoStack`, every item on `state.redoStack` (entry and plate snapshot).
`nsoReleaseGeometries(candidates)` takes the geometries that just left reachability, keeps any something still names and
disposes the rest. `nsoGeometriesNamed` is the holder scan (plain objects, arrays, Map / Set, Object3D; never into typed
arrays, Vector3s, materials). `nsoLeavingGeometries(items)` says what a leaving stack item named: for a `poseBake` its
`prevGeometry` and what it put on the piece (read off the redo item's snapshot, or off the live piece for a discard).

**Where entries leave a stack, and so where it is called** (all in app-core.js):

| exit | what leaves |
|---|---|
| `pushUndo` empties the redo line | the redo items |
| `pushUndo` trims past `UNDO_MAX` | the oldest undo entry |
| `redoLast` trims past `UNDO_MAX` | the oldest undo entry |
| `undoLast` trims the redo line past `UNDO_MAX` | the oldest redo item |
| `undoLast` of a step that is not redoable (`onUndone`, a preview, no change) | the old redo line, and what the Undo took off |
| `clearRedo` (Redo found the plate changed; Clear plate) | the redo items |
| `clearUndo` | both stacks |
| `undoLastDiscard` | the entry, and what it had put on |

Undo itself disposes nothing: the geometry it takes off is the redo item's, so Redo puts back **the same geometry**
(same uuid, no re-bake). Candidates are pose-bake geometries only (`nsoPoseBakeGeometries`, which also follows a
`stepGroup`): **the Seal -> Undo leak (2 geometries a cycle, since bba1993) is not fixed here** - it is fixed in
[undo-dispose-seal](undo-dispose-seal.md), which adds its entry type to `nsoPoseBakeGeometries` / `nsoLeavingGeometries`
and reuses `nsoReleaseGeometries` as it stands.

**poseHome.chain is not a holder.** It is a `WeakSet` that answers "is this geometry one of the run?" about the piece's
*current* geometry (`nsoPoseHomeHolds`), so it cannot name a geometry that is nowhere else. Counting it as one would keep
every baked geometry of a piece for good and the leak would stay. `poseHome.geometry` (the home) is a strong reference and is a holder.

**Numbers** (`npm run perf:bisect -- --kinds <kind> --probes load,leaks`, 10 cycles, headless software GL, same machine,
the tool's 1,000,000-triangle stand-in sphere - `ButVase.3mf` was not on the box; c0 = loaded, c1 = after the first
cycle, which legitimately holds one more geometry: the one on the redo line):

| cycle | | geometries c0 / c1 / c10 | heap MB c0 / c1 / c10 | MB per cycle, c2..c10 | scene objects c0 -> c10 |
|---|---|---|---|---|---|
| yaw, Undo | before (b8aba98) | 11 / 12 / **21** | 201.5 / 304.8 / **923.5** | 68.7 | 15 -> 16 |
| | after | 11 / 12 / **12** | 201.4 / 304.8 / **305.5** | 0.07 | 15 -> 16 |
| yaw, Undo, **new yaw**, Undo | before | 11 / 13 / **31** | 201.5 / 373.6 / **1610.0** | 137.4 | 15 -> 16 |
| | after | 11 / 12 / **12** | 201.4 / 305.0 / **305.4** | 0.02 | 15 -> 16 |
| yaw, Undo, **Redo**, Undo | before | 11 / 13 / **31** | 201.4 / 304.9 / **923.5** | 68.7 | 15 -> 25 |
| | after | 11 / 13 / **22** | 201.4 / 304.9 / **305.5** | 0.05 | 15 -> **25** |

The Redo cycle also asserts Redo puts back the very geometry the Yaw made (same uuid); it did, every cycle.

**The Redo row is not flat in geometries, and it is not a pose geometry.** Heap is flat (305.5 MB) but geometries and
scene objects both rise by one a cycle: every **Redo** adds another `selOutline` `LineSegments` to the piece's mesh.
`nsoWorldSnapshot` stores `outline: null` in the piece's fields; `nsoWorldRestore` writes that back over the live
`p.outline` without removing the outline still parented on the mesh, so the `refreshOutline` after it has nothing to
strip and adds a second. Measured with a throwaway strip of the live outline at the top of `nsoWorldRestore`'s first loop
(not in this PR): 12 geometries, 15 scene objects, 305.5 MB at c10. **Not fixed here** - different mechanism (selection
outline, not the stacks), and Redo is the path this ticket must not move. It is the obvious small follow-up.

**Gate.** `undo:dispose` (new, Node only, ~0.1 s): lifts the real `pushUndo`, `undoLast`, `redoLast`, `undoLastDiscard`,
`clearRedo`, `clearUndo`, the world snapshot / restore, `nsoUndoPoseBake` and the lifecycle helpers out of app-core.js
into a vm, with real `BufferGeometry` whose `dispose()` is counted. It checks Undo disposes nothing and Redo returns the same
geometry; a new action after Undo disposes exactly the undone one; ten yaw -> Undo cycles leave the home and one on the
redo line; every exit above; never a geometry shared by another piece, named by `poseHome`, or on screen; each holder
alone (model, undo entry, redo entry, redo snapshot, poseHome, a kept mesh, a step in a `stepGroup`). Seven deliberate
breaks of the fix each fail it (no release in `pushUndo`, a holder scan that skips the redo line / scene / pieces, an
Undo that disposes, a discard that does not release, an unreleased trim). What the vm cannot show - that the renderer
really lets go - is the table above.

**Known limits.** (1) A closure in an entry (`onUndone`) can hold a geometry the scan cannot see; such entries are not
redoable and name no pose geometry. (2) While Join's `asOneStep` runs, the entries under it are parked in a local, so
the scan cannot see them; a geometry named only there would be uploaded again, not lost - `dispose()` on a geometry
that is drawn again just re-uploads it. (3) A home geometry whose undo entry left the stack while `poseHome` still held it is not
disposed when `poseHome` is later replaced (a re-homing is not a stack exit): one geometry per re-homing stays. That
happens only after another op has replaced the piece's geometry, which is the next ticket's ground (Seal, ...).

`perf-bisect` gained two opt-in leak cycles for this (`--kinds yaw+undo+redo,yaw+undo+yaw`); the default kinds are unchanged.
