## Pottery Wheel - throw a vessel on an axis
`app-wheel.js` + `app-fit.js` + `nso_printer.js`, wired on their own
`?v=wheel1` tag (new files, so no existing tag was bumped) after `app-sculpt.js`
(it reuses `NSO_sculptCommitRaw`) and after `app-extend.js` (rim extension
calls it). UI is a **Wheel** menu in the viewport, beside Finish. Full
write-up, with every number: `docs/POTTERY-WHEEL.md`.

"Beside Finish" was the intent but not the truth until now. `.tp-detail` in
`styles.css` was missing its closing brace, so the parser swallowed the whole
`.viewport-overlay-wheel` rule as a nested block and discarded it - the Wheel
overlay had no positioning at all beyond the base `.viewport-overlay`. Closing
the brace then exposed a second bug: `.viewport-overlay-topbar` reserved a bare
`right: 88px`, which fitted Finish alone, so the revived Wheel menu landed on top
of `#btn-lock-pos` and swallowed its clicks (`npm run lock:test` died on a
pointer-interception timeout). Both are fixed: the three offsets now derive from
`--vp-menu-gap` / `--vp-menu-w` / `--vp-menu-count` in `:root`, and
**`npm run overlay:test`** pins it - it scans the stylesheet for unclosed blocks
without a browser, then renders the page and fails if any topbar button is
covered. Adding a third top-right menu means changing `--vp-menu-count` and
nothing else.

Four moves in the order a potter makes them - **Ball** (sized from a target
height by Pappus's centroid theorem), **Open** (one push; the single outer
profile becomes outer + inner and the piece is a shell from there), **Pull**
(drag-shape the profile at ANY height, spline-fitted, revolved to a clean
solid each update), **Trim** - plus **Rim +**, which is `NSO_extendRaw` and
not a second copy of it.

The piece is held as its MERIDIAN PROFILE and revolved fresh every update.
That is the decision everything else follows from: the two live constraints
are a scan of ~100 samples rather than a mesh query, which is what makes them
affordable per frame of a drag.

Four things a later ticket should read before touching this:
- **The cavity is not `outer(z) - wall`.** A radial subtraction leaves a
  perpendicular wall of `wall * cos(slope)` - measured at 1.446 mm where 3.00
  was asked, 51.8% under, worst near the base. Open bisects for the locus at
  perpendicular distance `wall` instead, which also sets the cavity floor and
  the rim for free. `docs/POTTERY-WHEEL.md` finding 2.
- **The wall floor is `NSO_Thickness.floorFor` and nothing else.** No `0.42`
  in this file, no default: loaded without `nso_thickness.js` it throws on the
  first move. The MEASUREMENT is this file's own exact scan, though, because
  `measureLoop`'s ray pass under-reports a meridian by 1.47 mm on a 3 mm wall
  (its `u in [-0.05, 1.05]` slop against short cavity-floor segments). Finding
  5 - and it is pinned by a test, so a fix to `loopWallAt` shows up here.
- **A vertical outside is not a vertical inside.** Pull carries the inner wall
  radially by default (cheap, exact in the radial gap). Pulling a wall
  straight that way leaves Extend refusing at 384/384 straddling triangles
  oblique; `opts.reshapeWall` rebuilds the inside from the outside and gives
  an 8.85 mm clean band. Finding 3.
- **`tools/nso_wheel_canonical_check.js` earns its place.** It caught a pulled
  bowl claiming a base at z = 0 while the mesh started at z = 0.112 - a Pull
  clamping radii to zero leaves a run of axis points the revolve drops, and
  nothing inside the wheel could see it. `NSO_wheelTidy` is the fix; the bbox
  comparison is a permanent gate. Finding 6.

Explicitly out of scope for this first version, and both real: **non-symmetric
appendages** (handles, spouts, feet - a meridian profile cannot express one;
that is a Join ticket) and **centring an arbitrary / asymmetric starting
mesh** (there is deliberately no entry point that takes a mesh in). The
self-test greps for both and fails if either appears.

`npm run wheel` (94 checks, headless), `npm run wheel:canonical` (80 checks,
`tools/mesh_validate.py` over every revolved piece, machine-compared, budget
included) and `npm run wire:wheel` (53 checks, real app). All in `npm test`.
