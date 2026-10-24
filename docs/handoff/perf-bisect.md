## perf-bisect - which merges made the app slower, and what grows in a session (2026-10-23)

A measuring tool, `tools/perf-bisect.mjs` (`npm run perf:bisect`). It changes no product file, has no pass/fail
and is not in the test chain. The results of a run are in the PR that added it.

**What it does.** Checks any commit of the first-parent chain into a scratch git worktree, serves it from
127.0.0.1 and drives it in headless Chromium (software GL, `--enable-precise-memory-info`) with the same probe
code on every commit. The probes reach the app only through what exists at bba1993 (`state`, `THREE`,
`applyPlacedXZ`, `#file-input`, the render loop, real mouse events); where a commit has nothing to drive the
probe says `n/a` and why.

**Probes** (median of 5 runs, worst kept): load (file given -> piece on the plate), first click on the vase
(-> next frame, app JS apart), drag (the way `nso_move_flat_bench.js` times it), Lift arm (-> ready), idle (app
JS ms / frame and frames / s over 5 s), orbit (a scripted 3 s orbit with real mouse moves). **Leaks:** four
cycles x 10 on the vase - yaw + Undo, Seal + Undo, arm / disarm the Cut preview, select / select the other
piece - sampled after every cycle (renderer geometries, textures, last frame's calls / triangles, scene
objects, JS heap after a forced GC, undo stack, live `setInterval`s, document / window listeners).

**Commands** (all resumable; a commit already in `tools/perf-bisect-out/` is skipped unless `--force`):

    npm run perf:bisect -- --plan                    the pass-1 commit list
    npm run perf:bisect -- --pass1                   measure it
    npm run perf:bisect -- --pass2                   bisect every probe / leak count that moved between neighbours
    npm run perf:bisect -- --selfcheck               bba1993 and 1b45aec twice each; every probe within 10 %?
    npm run perf:bisect -- --commits <rev>,<rev>     any commits on the chain (e.g. to rerun with the real vase)
    npm run perf:bisect -- --report                  rebuild tools/perf-bisect-out/perf-bisect.md
    npm run perf:bisect -- --profile drag --commits <rev>   a CDP CPU profile of one gesture (load|click|drag|lift) -> profile-<rev>-<gesture>.txt

**The vase.** `tools/fixtures-local/boolean-vase.3mf` (git-ignored) when it is on the box; otherwise the
1,000,000-triangle UV sphere of `nso_big_mesh_lib.js`, marked "stand-in" in every table. `--vase FILE` names
another (the first run of this tool used the owner's `ButVase.3mf`, the 947,444-triangle vase of docs/BIG-MESH.md, through
`--vase`). Options worth knowing: `--runs`, `--cycles`, `--kinds yaw+undo,...` (which leak cycles), `--bake seal|solidify`,
`--out DIR`, `--force`.

**Read this before trusting a frame figure.** Headless Chromium draws with software GL: ~0.4 s per million
triangles of main-thread time per frame, however little JS runs. Every "to next frame" and frames-per-second
figure is inflated by that; compare commits to each other and read the app-JS rows for the app's own cost.

**Known limits.** `{once: true}` listeners cannot be seen to remove themselves, so they are counted apart
(`onceListeners`); listeners set through `on...` properties are not counted. This app has no press-on-empty-plate
to deselect (a bare press orbits), so the select cycle un-selects the vase by selecting the box. A probe times
whatever the page does after the gesture; it does not profile - a number that needs a cause is followed up with
a CDP profile of that gesture.
