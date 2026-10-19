# Booleans in a worker

Crop's copy, Subtract B from A, Join, Connect, Bridge and the fills used to run
Manifold on the thread the page is painted by. On a 1.46-million-triangle 3MF
(the butterfly vase and its negative cylinder) Crop held the tab for the whole
run - and, because the card re-plans at every pause of a drag, for every plan too.
Now a big boolean runs in a worker and the page awaits it.

Gate: `npm run bool:worker`. Real file: `npm run bool:3mf`.

## Where a boolean runs

| size | where |
|---|---|
| both soups under `NSO_BoolConfig.bigTris` (50,000 triangles) | the page's thread, as before, **through the same async call** - no round trip |
| either soup at or past it | a worker, `NSO_Work` channel `bool` (Crop's plan: `bool-plan`) |
| no worker to be had (node, no `Worker`, an engine file not on the page) | the page's thread, as before |
| the worker cannot load the kernel (a page that lets the page `import()` it and not a worker) | the page's thread, once, as before |

`nso_csg.js` is the one file the page **and** the worker load. It holds what
used to sit in `app-join.js` and `app-finish.js`, moved unchanged (the diff shows
the move, not a rewrite): `NSO_CSG` and its URL, the weld and edge helpers
(`weldSoupVerts`, `NSO_weldEpsFor`, `NSO_edgeStats`, `NSO_manifoldStats`), the
clearance probe, and the bodies of the booleans. Three kept their behaviour and
changed their names, because the old names are now the doors:

| door (same name, arguments, result as ever) | core (the old body) |
|---|---|
| `NSO_unionSoups(a, b[, { label, host }])` | `NSO_unionCore` |
| `NSO_subtractSoups(a, b)` | `NSO_subtractCore` |
| `subtractSoupBFromA(a, b, opts)` | `NSO_punchCore` |
| `nsoUnionSoups`, `nsoSubtractSoups` | `nsoUnionCore`, `nsoSubtractCore` |
| `NSO_Crop.crop` (so `plan`, `run`, `copy`) | `NSO_Crop.cropCore` |

The worker runs **the same core**, not a copy of it: `NSO_Work` `importScripts`
the files the page already loaded, found from its `<script>` tags. The page posts
copies of the soups as transferables (it keeps its own arrays); the result comes
back moved. The Subtract punch's plug frame holds three.js objects, which do not
cross a worker boundary as themselves: they go over as numbers and are rebuilt in
the worker, which loads the page's own `three.min.js` for it.

Results are byte-identical to the in-thread core's: `tools/nso_boolean_worker_test.js`
compares them float for float, and every existing boolean check runs the in-thread
path unchanged (there is no worker in node).

## The overlap guard, which was most of the freeze

Before any boolean verb builds anything it asks the overlap guard (`nsoOverlap`, `nso-helpers.js`) whether the piece
is several shells laid over one another. Measuring that walks every triangle - **25 s of the page's thread on the
1,000,000-triangle sphere, 36 s on the vase** - once per piece (the answer is kept on its soup). On the sphere it was
the whole of a Crop's remaining freeze after the kernel moved, so it moved too: the measuring (`NSO_overlapMeasure`)
is in `nso_csg.js`, unchanged, and `nsoOverlap.refusalOfModelsAsync` asks a worker for a big piece (`Checking… 8 s`,
under the same bar and Escape). The sentence is the same. If the check is stopped the verb is refused in words, not
let through unchecked. Crop, Join, Subtract, Connect and Bridge ask the awaited form; their plan step, which asks at
every pointer move, takes a big piece's answer only if it is already known.

**Since work-as-is (docs/WORK-AS-IS.md) the guard no longer refuses.** The same measure (now also counting the shells
that cross) decides whether `nsoOverlap.solid` merges the piece's shells for the operation; the merge
(`NSO_shellMergeJob`) runs in the worker for a big piece too (`Merging shells… N s`). A stopped check or merge still
refuses in words.

## What the page shows

`app-bool-busy.js`. While a job is in a worker: the #226 bar (the Supports card's
sweeping bar - the kernel reports nothing, so no percent is drawn) under the
readout of the card that asked, or over the status line where there is no card
(Join, Subtract), and the words `Cropping… 12 s` (label and seconds the job has
run) in that readout and in the status line.

- **Escape** stops it: `NSO_boolCancelAll()` ends the worker (`NSO_Work` terminates
  it and the next job starts a fresh one). The caller's promise **settles** - with
  the op's own refusal shape plus `cancelled: true` - and the plate is as it was.
  Escape is taken in the capture phase, so the Crop card's own Escape (put the shape
  away) does not also fire. Join and Subtract stop the whole operation on it rather
  than fall through to another route.
- **The watchdog** (`NSO_BoolConfig.watchdogMs`, 120 s) ends a job the same way,
  with `timedOut: true` and `it ran longer than 2 minutes and was stopped - nothing
  was changed. These pieces are too heavy for this to finish here`.
- A newer **Crop plan replaces** the one still running (`key: 'crop-plan'`): the
  card asks again at every drag. A big piece's plan waits 400 ms after the drag
  settles instead of 90.

## The attached 3MF (the vase)

`npm run bool:3mf` drives it (the file is not in the repo; see the script's head). Measured here, in the headless
browser with software GL:

- The guard's verdict on the vase was **"has overlapping shells (4 piercing pairs)"**, the same sentence the unmodified
  app gives after freezing the page for 36 s, so CROP on it was refused; what this change made of it is that the check
  is a `Checking… N s` bar over a live page (longest stretch of JS on the page's thread: 20 ms). Since work-as-is
  (docs/WORK-AS-IS.md) CROP takes the copy: the vase's shells are merged for it, and `bool:3mf` gates that.
- The boolean itself (`NSO_Crop.run`, what CROP asks the worker): 20,188 faces, ~20-27 s, longest stretch of JS on the
  page's thread **20 ms**; on the page's thread the same copy is ~20 s with the page unresponsive. The bytes are equal.
- With the guard overridden (the drive's doing) the copy lands. What is left on the page's thread there is not the
  boolean: ~170 ms landing a 20,000-face piece beside a 1.46 M-triangle host (`copy`, `nso_crop.js`), and ~500 ms of the
  app's own Split-to-parts reading of the piece just selected (`app-split-parts.js`).

## Not moved, and why

- **Close, Extract bit, G-scope Crop Z** never ran Manifold. Close (`nso_close.js`)
  is a JS lid; Extract bit is a voxel flood fill; G-scope's Crop Z is
  `NSO_cropRaw`, a slab cut and seal. Their freeze, where there is one, is plain JS
  on the page's thread and is a different change: they are untouched, and their
  tests (`close:test`, `wire:extract-sel`) pass as before.
- **The landing** of a copy beside a big host and **Split to parts' reading** of a new selection (above).
- **Carve** still builds its own pair of kernel solids on the page to read what
  came out (`app-carve.js`), though its `subtractSoupBFromA` goes to the worker.
- **Crop's Outline** preview and footprint (`cutterSoup`, `footprintPolys`) build a
  cross-section on the page; a Box, Cylinder, Sphere or Piece copy is what moved.
- **G-scope's fuse** (`nso-gcode-solid.js`) drives the kernel directly, union by
  union, with its own junction limits.
- `app.js` is the retired monolith `index.html` no longer loads; it still carries
  its own copy of the old adapter and is not touched.
