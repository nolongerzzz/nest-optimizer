## Supports stair speed - the stair's build, same supports faster (2026-10-26)
Branch `claude/supports-stair-speed`, on `claude/supports-sheet-everywhere`. Engine only: `nso_thickness.js`
(the probe's walks), `nso_support_interface.js` (`exactDistance`, the stair's raster loops). The supports are
byte for byte what they were; no constant, cap, early-out or limit was touched.

- **Where the time went** (library tape, yaw 45 + tip 15, 4692 s at 44ac97d on this machine; `--cpu-prof`):
  78% in `stairOf` (`buildStairs`). Of that: `exactDistance` (via `solveStrip`'s `nearest`) 44%, the raster's
  per-layer fields (`fieldFor`, `fieldAt`, `bandOf`) 20%, the raster itself (`allHits`, the `near` test) 15%, GC 9%.
  `exactDistance` rebuilt B's grid (string keys, nested arrays) for every strip x shift x layer.
- **What changed (output identical):** `exactDistance` prepares B once (`exactPrep`) and works on plain numbers
  (`triTriFlat`; the hypot is taken only where a pair can beat the running minimum; an edge pair is held to the
  minimum by its boxes); the thickness probe finds cells by number, not string, and walks triangles as flat
  numbers (`allHits`, `nearestIn`; a ray straight up finds its column once); the stair's per-cell intervals are
  one typed array, `near` is stamped by window, the halo by rows; the field, halo and front loops are functions
  of their own that read no global per cell.
- **A harness cost, not changed:** `tools/nso_supports_print_export.js` runs the engine in a `vm` context whose
  globals are a sandbox object; every `Infinity`/`Math.*` in a loop is an interceptor lookup (the stair's
  field pass: 520 ms a layer there, 13 ms as a plain function). Run in the main context the same build was 2x
  faster on the short poses (5.3 s -> 3.0 s, before the loops stopped reading globals; the same hashes). The card's worker has plain globals. Switching the harness to
  `vm.runInThisContext` is one line, left for whoever owns the checks.
- **Not done:** the remaining time is `exactDistance`'s triangle pairs (~50%): the same pairs, fewer of them,
  needs a bound tighter than a box (ticket-sized).
- **The hashes** (`support:everywhere` holds the flat ones): tape yaw 45 + tip 15 `879061ea94fde992` (supports) /
  `8b0172401f853c4d` (the plan), unchanged; the six reference pieces x four poses, the coupon and `top_clip_x2`
  likewise. `fixtures/supports/supp_ref.3mf` was not at the base: the pieces of `tools/nso_support_ref_pieces.js`.
