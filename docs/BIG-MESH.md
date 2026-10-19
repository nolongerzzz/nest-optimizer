# Big meshes

A 947,444-triangle piece (the butterfly vase) froze the page on selection (34 s),
the Supports card (16 s), To plate (5.7 s), the Cut card (6 s), Lift hovers and
import (5 s). Every one was the same mistake: a question about a piece answered
by walking all of its triangles on the thread the page is painted by.

Measured by `tools/nso_big_mesh_profile.js`; the numbers are in
`tools/big-mesh-out/REPORT.md` (and the PR). Gate: `npm run big:mesh`.

## What changed

| | where | what |
|---|---|---|
| one tree per piece | `nso_bvh.js` | The support planner's BVH (#216), moved out and shared: binned-SAH boxes, four triangles to a leaf. Built once per array **in a worker**, cached on the array (WeakMap), valid while the array, the attribute's version and its size are what they were at the build. `Mesh.raycast` is replaced (`installThree`) for plain non-indexed meshes of 50k+ triangles: the tree names the triangles the ray's boxes can reach and **three's own per-triangle test** runs on those, so a hit is the walk's hit to the bit, in the walk's order. The planner calls the same `indexFor`; where only the planner is loaded it keeps its own copy of the build (held equal by `tools/nso_bvh_test.js`). |
| a worker for any engine | `nso_work.js` | `NSO_Work.run(channel, scripts, 'Name.fn', args)`: the engine files the page already loaded are `importScripts`ed (found from the page's own `<script>` tags), the function is called, the result comes back. Same pattern as the support planner's build worker. |
| import | `app-core.js` | A big piece (300k+) is registered, its tree is built with a progress line (`Indexing …`), and only then put on the plate. A 4 MB+ 3MF is parsed in a worker (`nso-3mf-read.js` `parse3MFTransfer`). |
| outline | `nso_edges.js`, `app-sel-outline.js` | `EdgesGeometry` without a string per vertex, identical output (`tools/nso_edges_test.js`). Big piece: made in a worker, kept per geometry version, so To plate / re-select is instant. |
| split-parts | `app-split-parts.js` | Big piece: read in a worker, only once the Subtract card is open; the card says `measuring…`. `NSO_SplitParts.splitFrom` reuses the read for the verb. |
| supports detect | `app-supports-card.js` | Big piece: `detectOverhangs` in a worker; the card says `measuring…`. |
| bounds | `nso-bounds.js` `localBox`, `app-crop.js` `NSO_cropBounds` | The vertex-walk box the cutter asks on every blade move is kept for a big geometry/soup. |
| Lift hover | `app-lift-plate.js` | One ray a frame (as before) now costs microseconds; no whole-piece face scan on hover; a feature of more than 5,000 triangles is drawn from the tree's hit triangle, not by outlining its triangles; the "everything offered" outline is kept between hovers. |

Everything new applies **only above its threshold** (tree 50k, "big" 300k), so a
piece the existing checks use is handled exactly as before.

## What is not fixed

- **Arming Lift** still reads the piece on the page's thread (4 s on the vase).
  Its analysis holds closures (`A.M.twin`, per-island `base`, `map.sampler`) that
  cannot cross a worker boundary; moving it needs the engine to hand back plain
  data.
- **Import** still has one ~0.9 s task: the ingest of a piece that size (rotate,
  vertex normals, centre) in `addModelFromZUpGeometry`, plus ~0.5 s of the first
  frame's GPU upload.
- Hover tools other than Lift (Bridge, Connect, Close, Patch) now get a fast ray
  but still build their own per-piece analyses on the page's thread when armed.
- The overlap check and the shell merge (`nsoOverlap.solid`, docs/WORK-AS-IS.md) run when a verb that needs a
  solid asks for them, in a worker for a big piece (docs/BOOLEAN-WORKER.md), for every such verb.

## Measuring in the headless browser

The page draws with software GL there: ~0.4 s a frame per million triangles on
the main thread's own time, with nothing selected and the app idle. So the gates
read the stretches where JS was on the stack (DevTools sampling profiler), and
print the browser's raw Long Tasks beside them.
