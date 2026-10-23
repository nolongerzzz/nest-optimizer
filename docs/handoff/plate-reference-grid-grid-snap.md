## Plate reference grid + grid-snap (landed, `app-core.js`)

Full write-up with numbers: `docs/PLATE-GRID.md`. Suite: `npm run grid:plate`
(`tools/nso_plate_grid_test.js`), added to the `test` chain so CI gates it.
Branch: `claude-wip-plate-grid`. No `?v=` tag bumped — Grok owns those.

A flat, world-aligned grid owned by the build plate, plus an optional soft snap
on the same lattice. Controls in the Plate card: `#plate-grid-show`
(auto / on / off, default auto) and `#chk-plate-grid-snap` (default off).

Three things the next ticket should not re-derive:

1. **Two grids now, and they are different features.** The surface grid
   (`app-seat-grid.js`, `b0dc10d`) draws on the Join/Seat target piece; this one
   is the bed. At the tip this branched from (`2a6d07a`) the surface grid did
   not exist, so the audit found no pattern to copy and the modes here were
   designed from the ticket; it landed in parallel and the two converged anyway
   — both carry `['auto','on','off']` and both kill picking with a `raycast`
   no-op. Naming is what the merge had to settle: `state.seatGridMode` and
   `#btn-seat-grid` for the surface grid, `state.plateGridMode` /
   `state.plateGridSnap` and `#plate-grid-show` / `#chk-plate-grid-snap` for the
   plate. Suites: `grid:math` + `grid:wire` are the surface grid's,
   `grid:plate` (`tools/nso_plate_grid_test.js`) is this one's. They share no
   code, and the surface grid was not touched.
2. **The old `plateGrid` was a `THREE.GridHelper` and is gone.** Same state
   slot, same name, same lifecycle in `buildPlateMesh` — but it was square at
   `max(w, d)` (overhanging a Prusa bed by 40 mm), had no round mm spacing to
   snap to (14.22 mm on an A1 256), and was a `hitPlateSurface` pick target.
   It is now an owned `Group` of two `LineSegments`, clipped to the real plate,
   on a 10 mm lattice, and removed from the pick list. `plateMesh` covers the
   same footprint so plate-drag orbit is unaffected.
3. **`PLATE_GRID_SNAP_STRENGTH` must stay below 1.** The snap maps the cursor offset
   `d` from the nearest line through `f(d) = R((1-S)u + Su²)`, `u = |d|/R`. The
   slope is `>= 1-S`, so `S < 1` is what makes the mapping strictly increasing —
   which is what makes this an assist you can always drag out of rather than a
   lock. At `S = 1` the slope at the line becomes 0 and it locks. The suite
   measures monotonicity on a real 41-sample drag sweep, so raising `S` to 1
   fails `npm test` rather than shipping a lock.

Paint: not applicable. The standing rule binds bake mechanisms; this draws lines
and moves a placement coordinate, and touches no triangle. Stated in
`docs/PLATE-GRID.md` §4 so the category question is answered once.
