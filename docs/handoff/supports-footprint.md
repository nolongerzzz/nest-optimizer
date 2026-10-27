## Supports footprint - the beacons' outline is the surface's own edge (2026-10-26)

Branch `claude-wip`. Engine: `nso_support_beacons.js` (`footprints()`: `region.footprint`, `opts.insetMm`, `opts.footprint`),
`nso_support_interface.js` (`opts.perimeter`: the field and the caps' rims kept to the part, `PERIM_GROW_MM`),
`nso_support_gridpack.js` (`opts.sheetPerimeter` into `sheet()`), `nso_support_aim.js` (`opts.beaconInsetMm` into `detect()`).
Card: `app-supports-card.js` (the outline from the loops, the click test, `view().areas[].footprint / outlineEdges`).
Gate: `npm run support:footprint` (`tools/nso_support_footprint_check.js`, ~1.5 min; `--no-build` 5 s). Docs: `docs/SUPPORT-FOOTPRINT.md`
(the whole story and the tables), `docs/SUPPORT-BEACONS.md` (Footprint), `docs/SUPPORTS-CARD.md` (the outline, the old flag removed).

- **The ask (the owner's):** make the beacons reflect the actual perimeter of the model / contact surfaces, so they do not stick over the edges and
  build odd interfaces; `supp_ref.gcode.3mf` (Bambu's slice of the six reference heads) as the guide.
- **The fault:** the card outlined a hanging area as the edges of the 3 mm grid cells its spots were found in. A cell found by a corner is mostly air:
  41 % of the Base's outlined cells lay over nothing, 46 % of Oblique's, 61 % of Negative Sphere's (all six heads are diamonds in plan: every edge cell is
  a corner cell). The tips, caps and sheets followed: a corner spot stood on the edge, its cap and the sheet's field hung off the part; the Negative
  Spheres' sheets lay 41 - 62 % outside the part in plan.
- **Bambu's interface is the underside, to its edge** (read off the G-code): the footprint this ticket traces is 0.95 x its area on Base and Oblique, 0.99 on
  Circular, 0.95 on Sphere (the old cells: 1.6 - 1.9 x). The Negative Spheres' apex surface is not detected (OPEN, unchanged).
- **Everything is asked for, nothing is on by default** - the planner suites pin the spots and the sheets' bytes: `detect` `footprint` /
  `insetMm` (default off / 0), `sheet` `perimeter` (off). The card asks all three. `support:index` is why: a footprint field in the plan changed its
  hash, so it is only added when asked.
- **A found-on-the-way:** the first version moved every spot near an edge 1 mm in. On Oblique (a tilted plane) and Circular (a dome) that broke the
  stair and the flat sheet's reach, which stand on tips at the grid's own points: Oblique's stair became five bare tips and 0.00 mm of sideways
  clearance. Only an area of flat faces keeps its spots in now (Base, a plate, a cap).
- **A real bug found on the way** (the footprint's own): a cell index outside the grid aliased another cell's key in the cell map
  (`j * nx + i` with `i < 0`), so a flood from a cap's rim ran 6 mm past the cap. Bounds are checked.
- **Measured** (`support:footprint`, six heads, the flat faces of the stack and the caps' tops outside the part's plan): 21 % before, 8 % now; none out
  by more than 1.2 mm; `support:onetrunk` (now built the card's way) 19 / 19. **Cost:** the clamp's one-trunk build in the card is 15.9 s against 12.2 s
  (88.6 of the gate's 105 calibration loops; 65.5 before), the wedge 8.8 s against 5.9 s. The first version asked every level for the outline and cost
  83 s on the clamp: the old way is built first now, and the outline only for a level with a tip within 3.6 mm of the part's edge
  (`PERIM_NEAR_MM`). If the gate is ever tight, that is the knob (and `PERIM_GROW_MM`'s five steps).
- **Second round, "the interfaces follow the surface" (2026-10-27):** (1) the **finer look** - `opts.seedPitchMm` (card: 1 mm): after the footprints, `detect` samples
  again at 1 mm and a surface no footprint holds becomes a seed beacon of an area of its own (a 0.6 mm ledge: found in 12 of 12 grid alignments, 5 of 12 before;
  the Negative Spheres' apex, never detected, is an area with a sheet now; nothing seeded on the four heads, the clamp or the wedge). (2) the **fill** - the card
  passes `footprintsOf(regions)` as `sheetFootprints`: a level's field runs 3 mm past a cap's rim to the footprint's edge (Base's sheet 72 % -> 81 % of its
  footprint, 0 mm2 outside the part), for levels of 16 tips or fewer; a rim too thin falls back to the outline as before. (3) `bestRect` counts a rectangle's
  caps by a closed form (same bytes, a large level 3x faster). Measured: `support:footprint` 48 / 48 (new: ledge x12 alignments, finer-look coverage, THE FILL, THE
  APEX), `support:onetrunk` 21 / 21 (the pad gate reads a shared pad against all its trunks), `support:workflow` card 80, counts 48, builds 46 (clamp 101.9 loops,
  wedge 43, quiet gap 4.0). **Re-pinned** in `support:plate`: Negative Sphere2 23352 triangles `7cccdebaa3bb`; the apex is a fourth area (`3 pieces · 8 hanging areas`, 4 a piece,
  `5 pieces · 16`, Cave unreachable 4) and each built Negative Sphere2 shows "unreachable 1" - one crest spot of the apex the planner leaves (3 tips hold 8 of 9).
- **Not done:** the sheet is on the part and near-fills it (Base 81 %, the rectilinear pieces stop short of the rounded corners; levels over 16 tips are not filled); a rim thinner than the 2 mm lines still gets a piece
  reaching up to 1.2 mm out; a stair is not held to the outline; a tip too near a corner for its own sheet gets the least piece that fits; G-scope's markers
  and hand-placed spots keep their cells. Details in `docs/SUPPORT-FOOTPRINT.md` section 6.
- **Drives run** (alone, headless Chromium): `support:workflow` card 80 / 80, counts 48 / 48 (the tunnel ceiling's 24 / 72 is 28 / 68, re-pinned with the
  reason), builds 46 / 46. `support:custom` is red here at the claude-wip too (the circles check's 1e-3 camera tolerance and the hover's trunk ids flake
  between runs, then a TypeError in section 6: the same on a clean worktree of afe0ed4); it is not changed.
- **Environment:** `node_modules` needs `three` (`npm install --no-save three@0.147.0`) and, for the `.mjs` drives, a link to the preinstalled Playwright
  (`ln -s /opt/node-tools/node_modules/playwright node_modules/playwright`, and `playwright-core` beside it). Do NOT `npm install` playwright: it is
  1.56.1, wants a browser build this box lacks, and shadows the one that works.
- **Third round, the plate measured (2026-10-27):** the owner's report was the plate taking 1:50 (21 s before the beacon work) and its interfaces "nowhere close". Measured, in
  `docs/SUPPORT-FOOTPRINT.md` section 8: node 15 -> 36 s, browser here 12.5 -> 24.4 s; the outline and the finer look are about 7.4 s of the browser's 24 s and the rest is upstream's;
  all of mine is in the last-resort sheets (`lateTry`). Shipped, same bytes: the geometry queries kept by their arguments (36 -> 30 s node). Tools: `npm run support:coverage` (the share of each
  footprint with support under it: Base 88, Oblique 92 aligned / **12 turned**, Circular 35, Sphere 64, Negative Sphere 61, Negative Sphere2 50) and
  `tools/nso_support_plate_browser_time.mjs`. **Open and not mine to pick:** the Oblique's stair only stands at 0 and 75 deg; a dome is one flat patch; a 1 mm rim has no sheet. The thin-tip option
  (45 -> 33 s turned, interface lost on the rims) was measured and not shipped.

- **Fourth round, the region plate (2026-10-27, after "the interface generator driven by a region, not by tips"):** `opts.regionPlate` (card: `PARTS_OPTS.sheetRegionPlate`, with
  `footprints`) lays the transition and the interface from each footprint and the surface's height, layer by layer: an outline loop and a 45 / 135 deg hatch, the plate stepping up a dome,
  the tips inside the footprint carriers cut to the plate's bottom (`shellPass()` in `nso_support_interface.js`; geometry in `api.region`: `edtCells`, `isoLoops`, `concentricLoops`,
  `plateOfRegion`, `smoothMask`, `fitRing`). A footprint that is one planar slope is the stair's and untouched (the Oblique is being reworked by its owner). Measured
  (`support:coverage`, six heads on the plate): **15.3 s aligned / 20.7 s turned** (30 / 44 before); coverage Circular 35 -> 88 %, Sphere 64 -> 98 %, Negative Sphere 61 -> 68 %, Negative Sphere2 50 -> 71 %,
  turned within 10 points of aligned; the **Base 88 -> 83 %** (not traced further), the Oblique unchanged (94 aligned, 12 turned: the stair). Gates: new `support:region` (28), `support:coverage`
  floors + rotation + seconds, `support:plate` section 6 re-pinned (Negative Sphere2 27568, Circular 14128, Sphere 15152 triangles; stable over three runs), `support:workflow-builds` 46 / 46
  (the plate tells the bar as it goes: the clamp's first-3.5-loops gate). Everything with the option off is byte for byte as it was. `support:custom` is red at the claude-wip too (the
  circles check; same on a clean checkout). **Not done:** a rim under about 1 mm is loops without a hatch; a painted region (same generator, a mask for the footprint: no tool yet); printability is untested
  (no print made). Details: `docs/SUPPORT-FOOTPRINT.md` section 9.
