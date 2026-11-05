## outline-cost - turning a piece moves its outline instead of rebuilding it (2026-10-31)
Branch `claude/outline-cost`, off `claude-wip` @ 09d4e89; PR against `claude-wip`. New step `outline:cost`
(`tools/nso_outline_cost_test.js`, in `driveSteps`, weight in `tools/test-weights.json`).

**The cost.** The selection outline is `EdgesGeometry(geometry, 15)`. On the owner's 191,276-triangle Cartoon-Hand it was
built again for every select, every Yaw / Tip / Tilt / Bank / Flip, every Undo, and **twice** in a pose op (the bake's own
`refreshOutline`, then the verb's). A Rotate-ring drag built it on every move (39 builds in a 40-move drag, 43 s here). A
mid-size piece did it on the main thread because the worker path started at `NSO_BVH.BIG_TRIS` (300,000).

**What it is now** (all in `app-sel-outline.js` unless said):
1. **The edge set is kept per geometry** (`edgeCache`, a WeakMap): key = the geometry + its position array + that
   attribute's version and count, the way `nso-bounds.js` keys a box. Re-selecting an unchanged piece is a lookup.
2. **A pose bake moves the outline with the piece.** `nsoBakePlacedPose` (app-core.js) already knows the matrix it applies:
   every vertex goes `v -> q v - shift`. It builds that `Matrix4`, stores it on the `poseBake` Undo entry (`outlineM`) and
   calls `nsoOutlineCarry(p, newGeo, M)`, which transforms the kept edge set into a new array filed under the new geometry.
   `nsoUndoPoseBake` calls it with the inverse, `redoLast` with `M` again - both only matter when the target geometry's
   edges are not already kept (they normally are, so Undo / Redo put back the very edges they had). The source is the
   geometry's kept set or, failing that, the outline on screen. **Guard:** 24 vertices spread over the geometry are
   carried by `M` and held against the target's own within 1e-3 mm; if they disagree (a bake whose new soup is not the old
   geometry turned) nothing is carried and the piece is built the ordinary way.
3. **`refreshOutline` does nothing when the outline on the piece is already the geometry's** (`isFor`: the line carries
   `{uuid, arr, version, count}` in `userData`, plain values only - the geometry scan in `nsoGeometriesNamed` reads
   userData). The outline is in the mesh's own frame and a child of the mesh, so every move, lift, pose in hand and
   second ask for the same thing is free. That is what makes "one update per op" true without editing every caller, and
   what makes a ring drag build 0 (it used to rebuild per move) and draw 0.
4. **From 50,000 triangles an outline is built in the worker** (`OUTLINE_WORKER_TRIS`; `NSO_BVH.BIG_TRIS` untouched).
   The piece is selected at once and the line appears when the worker answers. A job for the same geometry already
   running is not started again; an answer is kept even if the piece has moved on (the Undo that goes back finds it); a
   failed worker falls back to a build on the spot (it used to leave the piece with no outline). Indexed geometry keeps
   three's own path (the worker engine reads soups).
5. **`nsoDropStrayOutlines`** (app-core.js, in `nsoWorldRestore`): found by the new gate. An outline is a child of its
   mesh, so a mesh taken off the plate keeps its line, and a Redo that puts the mesh back put the line back next to the
   one `refreshOutline` then drew (two `selOutline`s, then one stuck after deselect). Redo now strips what the restored
   mesh holds.
6. `window.NSO_Outline` (`WORKER_TRIS`, `cached(g)`, `forgetAll()`) for the checks; `refreshOutline(p, { now: true })` for
   a caller that wants the line before it returns (the Supports card) - `now` keeps the old rule (worker only from
   `BIG_TRIS`) so a plate-wide light-up of mid-size pieces does not lose its outlines.

### Numbers (this sandbox; headless Chromium, software GL; one run each, repeat runs agree within about 15 %)
Main-thread ms = JS on the main thread (DevTools sampling profiler) from the operation to the moment its outline is on
screen; frames drawn by software GL are not JS and are not counted. Builds = full edge builds (three's
`EdgesGeometry`, `NSO_Edges.edgesOf`, or a worker job), counted from outside the app so the same script ran on 09d4e89.
**Split to parts' read is stood down in these runs** (see "Over 100 ms" - it is 5-9 s and unrelated); the last table has
the rows it lands in.

| | stand-in (191,000 tris) before -> after | | hand 3mf (191,276 tris) before -> after | |
|---|---|---|---|---|
| operation | ms | builds | ms | builds |
| select | 1,372 -> **235** | 1 -> 1 (worker) | 1,565 -> **172** | 1 -> 1 (worker) |
| re-select | 1,093 -> **16** | 1 -> **0** | 1,158 -> **18** | 1 -> **0** |
| Yaw | 3,062 -> **672** | 2 -> **0** | 3,285 -> **511** | 2 -> **0** |
| Tip on side | 2,536 -> **382** | 2 -> **0** | 2,707 -> **309** | 2 -> **0** |
| Stand | 2,894 -> **475** | 2 -> **0** | 2,793 -> **329** | 2 -> **0** |
| Tilt | 2,691 -> **569** | 2 -> **0** | 2,643 -> **298** | 2 -> **0** |
| Undo (of the Tilt) | 2,690 -> **115** | 2 -> **0** | 2,434 -> **95** | 2 -> **0** |
| Redo (of the Tilt) | 1,375 -> **99** | 1 -> **0** | 1,477 -> **95** | 1 -> **0** |
| ring drag, 40 moves | 42,881 -> **255** | 39 -> **0** | 42,543 -> **248** | 39 -> **0** |
| ring drag release | 2,687 -> **314** | 2 -> **0** | 2,764 -> **302** | 2 -> **0** |

The "after" select is the worker's: the main thread pays for the copy in and the line out (~10 ms); the rest of the 235 /
172 is `selectPlaced`'s own body (below). Every pose op, Undo and Redo is exactly **one** outline draw (it was two).
Full per-op tables (Flip, Bank, every Undo / Redo) print from `node tools/nso_outline_cost_test.js --table`, and
`--file tools/fixtures-local/cartoon-hand.3mf` runs the hand (git-ignored; copied from the 3mf the owner attached).

With Split to parts' read live (first select of a soup, and every Redo of a bake): stand-in select 7,464 -> 5,674 ms,
Redo 7,900-8,600 -> 6,200-9,300 ms; hand select 7,373 -> 7,073 ms. The read is the same before and after.

### Gates (`outline:cost`, stand-in = lumpy ellipsoid with flat caps, 191,000 triangles)
select 1 build, re-select 0; Yaw, Tip on side, Stand, Flip, Tilt, Tilt (bank): 0 builds and one draw each; Undo and Redo
of each: 0 builds, one draw; a Rotate-ring drag: 0 builds and 0 draws over 40 moves, 0 builds and one draw on release;
after every one of those the outline equals a freshly built `EdgesGeometry` of the posed piece (same edge count, every
vertex within 1e-4 mm; worst measured 7.6e-6); Undo and Redo with every kept edge set forgotten still move the outline
by the bake's matrix (0 builds, matches); a real bake (Mirror) builds nothing itself, re-select builds once, Redo 0; a
geometry swap asked for twice builds once; selOutline count per piece <= 1 after select, deselect, Undo, Redo, Remove,
Remove + Undo.

**Why the stand-in is built the way it is (read before changing it).** A carried outline and a rebuilt one agree to
1e-5 mm but NOT always on the edge count: a crease within a few thousandths of a degree of 15 comes out on either side
when the turned copy is rounded to float32 again (measured: a 14.998 degree crease, count 22,662 vs 22,661 after a 15 degree
Tilt), and a 3mf with coordinates on the 1e-4 weld grid (x.xxxx5) welds differently after any turn. Neither is the
carry being wrong - a rebuild of the same piece moved by a hair would do it too. So the stand-in has flat caps (a
sphere's pole fans are slivers at every angle), a smooth swell under 5 degrees and plates whose walls stand at 80+, and
the run checks that `NSO_Edges.edgesOf` finds the same count at 14.9 and 15.1 degrees (no crease near the threshold).
**On the hand the counts differ by 0-4 of 9,728 edges (<= 0.04 %) after a turn** - the run prints them as `note`, not as
a failure, for `--file`; positions of every edge in common agree to float32. If an exact count is ever wanted on a scan,
the fresh build, not the carry, is what has to be pinned to the original.

### Every call site of `refreshOutline`
Changed (behaviour): **`app-sel-outline.js`** `refreshOutline` itself (cache, no-op when current, worker from 50k,
fallback, `opts.now`) and `nsoOutlineCarry`; **`app-core.js`** `nsoBakePlacedPose` (matrix on the entry + carry),
`nsoUndoPoseBake` (inverse carry), `redoLast` (carry forward), `nsoWorldRestore` (`nsoDropStrayOutlines`);
**`app-cth.js`** the wrapper passes its second argument on; **`app-supports-card.js:2823`** `light()` passes
`{ now: true }`.
Left, and why (all are now free when the outline is current, so none builds twice and none needed editing):
- app-core.js:445 `nsoWorldRestore` - every piece asks; only the selected one draws, from the cache (Redo: 0 builds).
- app-core.js:912, :988, :2972 - Undo of a replace-type / posePlaced entry and `restoreMeshY`: the second ask after the
  Undo's own, no-ops; `restoreMeshY` was the second build of every Undo.
- app-core.js:4264 `flipSelected`, :4279 `tipSelected`, :4292 `rollSelected` - the second ask after the bake; no-ops. Kept:
  they are the only draw when the bake has nothing to bake.
- app-core.js:4305 `liftSelected`, :4357 `bringSelectedToPlate`, app-move-vertical.js:142 / :159 / :284 (lift, strafe,
  slider) - the mesh moved, the outline is in the mesh's frame: no-ops. (These rebuilt the outline per arrow press and per
  slider tick on a big piece.)
- app-core.js:4648 end of `nsoBakePlacedPose` - the one draw of a pose op, fed by the carry.
- app-core.js:4691 `nsoPoseHome`, :4722 `nsoUndoPoseBake` - draw from the cache.
- app-rotate-handles.js:381 `writePose` (every move of a ring drag, a key, a dart) - no-op: 0 builds, 0 draws in hand;
  :780 `seat()` - after the bake, no-op.
- app-tip-orient.js:43 `setOrientFromQuat` - no-op before the bake.
- app-grab-drop.js:101 `placeAt` (every pointer move of a carried piece) no-op; :117 `restore` no-op/cached; :191 after a
  drop-seat that replaced the geometry: one build through the cache and the worker.
- app-library.js:387, app-mold.js:645, app-relief.js:227, app-seat-surface.js:321 - a new piece or a new geometry: one
  build, in the worker from 50k.
- app-sel-outline.js:188 the `selectPlaced` wrapper - cache hit on re-select.
- `app.js` (9,900 lines, not loaded by `index.html` or any check) has its own copy of `refreshOutline` and the strippers;
  left alone, as dead as before.

**Found, not changed.** Sculpt-style commits (`NSO_sculptCommitRaw`, used by Mirror, Brush, Scale, Hollow, Text, Punch,
Carve, Skin and some twenty more) put a new mesh on the
piece and never ask for an outline: the piece shows none until the next select, and `p.outline` is left naming a line on
the discarded mesh (never disposed). The same for the Undo of a replace-type edit, which puts back a CLONE of the old
geometry (`pushUndo`'s `prevGeometry`), so its first select after the Undo costs one worker build, not zero. Both are as
they were on 09d4e89 (checked there); the gate pins "re-select builds once, never twice". One line,
`refreshOutline(placedEntry)` after `nsoReseatPlacedPose` in `NSO_sculptCommitRaw`, would show the outline after every such
edit - a behaviour change, so left for the owner.

### Over 100 ms in those ops after the fix (named, not fixed; stand-in, same machine)
1. **Split to parts' read, 5.1-9.3 s**: `app-split-parts.js` `refresh` -> `read` -> `NSO_SplitParts.analyse` ->
   `cavityShells` -> `NSO_Thickness.prepare`, in a `setTimeout(0)` task after the first select of a soup and after a Redo
   of a bake (whose soup was never read). Its worker starts at `NSO_BVH.isBig` (300k), the same rule the outline had, and
   it runs whether or not the card is open when the piece is smaller. Cached per soup afterwards. By far the largest
   remaining; it is the same fix (its own threshold, the existing `NSO_Work` path).
2. **`nsoBakePlacedPose` itself, 220-750 ms per pose op**: `pieceFrame` (nso-bounds.js:368, hull + calipers over every
   vertex) 160-330 ms when its per-geometry cache is cold, `rawResultToDisplayGeometry` (turn, `computeVertexNormals`,
   centre) 75-180 ms, `nsoTurnRaw`.
3. **`updateEditSize` -> app-scale.js:1577 wrapper -> `syncCutUI` (app-cut.js:576) -> `cutFrame` (app-cut.js:225) ->
   `getCutPlaneLocal` / `cutTravel` -> `pieceFrame` again, 80-550 ms** on Yaw, Tip, Stand, and on Undo and Redo (Tip on
   side Undo 600 ms, Yaw Redo 650 ms): every geometry swap goes through `nsoInvalidatePieceBounds`, which drops the frame
   cache even when Undo puts back a geometry whose frame was already measured.
4. `selectPlaced`'s own body, 170-240 ms (the same `updateEditSize` chain, plus the wrappers in app-finish.js:6344 and
   app-split-parts.js:331).
5. Ring drag release 310-410 ms: items 2 and 3.
Nothing else is over 100 ms; a ring-drag move is about 6 ms.

### Tests
- New: `outline:cost` (driveSteps; weight 290,000 ms, an estimate - 3.6 min locally x 1.7 - until CI measures it).
- Changed: `tools/nso_undo_dispose_test.js` lifts `refreshOutline` out of the source by name, so it now lifts the helpers
  it calls too and `nsoDropStrayOutlines`; it counts the outline's line geometries (what is drawn) instead of the
  `EdgesGeometry` objects (scratch now); its Yaw helper ends with `refreshOutline` as the bake does.
- Passed on the final tree: page:manifest, edges:test, undo:dispose, undo:redo, pose:bake, pose:bake-release,
  pose:bounds, pose:drive, tip:orient, rotate:handles-ring, rotate:handles-bed, helpers:teardown, select:test,
  input:mode, lock:test, lock:multi, grab:drop, split:parts, seat:surface, cth:unit, support:workflow-counts.
  Passed one change earlier (the only change since is `nsoDropStrayOutlines` in `nsoWorldRestore`): move:vertical,
  crop:drive, crop:shapes, relief:drive, mold:drive.
- Fail the same way on 09d4e89 in this sandbox (run there to compare), not touched by this change: `big:mesh` (two timing
  gates, "on the plate in under 6 s" and "a click selects in under 300 ms of JS", then a GATE ERROR reading
  `sup.value.first`), `rotate:drive` (the 1-degree arrow-key checks, then a null `y` in the harness), `support:custom`
  (`nsoSupportFeed` of undefined at the end; its "hovering the trunk lights it" check failed once in the first run and
  passed on the second and on the base - the trunk id differs between runs).
- Environment: this box has Chromium 1243 where the harness looks for `chrome-linux/chrome`, so the runs used
  `PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`, and `page:manifest` gate 6 needs a
  `chromium_headless_shell-1194/chrome-linux/headless_shell` symlink (made in the sandbox, not in the repo).

### Next
- Split to parts' read to the worker below 300k (item 1) - the select and Redo that still take seconds.
- A cheaper frame after Undo / Redo (items 2-3): `pieceFrame` for a geometry that was already measured.
- The outline after sculpt-style commits and after replace-type Undo (see "Found, not changed").
