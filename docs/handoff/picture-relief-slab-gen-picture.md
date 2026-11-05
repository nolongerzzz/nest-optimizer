## Picture -> relief slab - Gen+ -> Picture (2026-10-12)
Branch `claude/picture-relief`, off `claude-wip`. Full write-up: **`docs/RELIEF.md`**.

- **What it is:** `nso_relief.js` turns `{ width, height, data, channels }` (the
  ImageData shape Trace raster takes) into a closed slab: grayscale, 1st..99th
  percentile auto-contrast, `levels` bands (or smooth), an exact box-filter
  resample onto the Detail grid, then a top heightfield at `base + h relief`,
  four walls and a flat floor at z = 0. Census on the index buffer (chi 2) before
  anything is returned; canonical checker in the tests. Triangle count is closed
  form - `4 (nx+1)(ny+1) + 4 (nx+ny+2)` - so the card's line is exact and the
  400k budget refuses by name with the Detail that fits.
- **The floor is a full grid, and that was measured, not chosen:** a strip floor
  (no interior vertex, half the triangles) closed fine and could not be sculpted -
  Smooth refused on volume loss (25.88%) and the Brush's gate refused on
  T-junctions / self-intersections from the long floor edges. Numbers in
  RELIEF.md section 1.
- **Card:** Gen+ -> Picture, after Stock. Ordinary ingest
  (`addModelFromZUpGeometry`), named after the file, one `addModels` Undo step,
  nothing else on the plate touched. Paint scope: none (roster row above).
- **Found, not fixed:** an Emboss stroke across steep ink ridges is refused by the
  Brush's own gate (self-intersections 0 -> 14), piece unchanged - the per-dab
  normal from the raycast lands on a ridge flank at 55.8 degrees. Over open
  paper it bakes. Brush behaviour, not this ticket's.
- **Fixtures:** `fixtures/relief/camera.png` (CC0, scikit-image's sample photo)
  and `line-drawing-scan.jpg` (a SIMULATED scan, `tools/nso_relief_scan_fixture.py`).
- **Checks:** `relief:test` (277), `relief:sculpt` (12), `relief:drive` (37) in
  `npm test`; `relief:shots` keeps the drive's screenshots in `tools/relief-out/`
  (gitignored - screenshots go in the PR description, never in the repo).
- **Defaults are the ticket's:** Detail 0.3 mm/sample, Base 2 mm (Width 60,
  Relief 2, Levels 2). A 60 mm square picture is 163,212 triangles - at 0.2 it
  was 364,812, already most of the 400k budget.
- **Tags:** `nso_relief.js` new at `relief2` (its defaults changed after
  `relief1` was pushed), `app-relief.js` new at `relief1`; `styles.css` `ring1`
  -> `relief2` (this card's rules merged onto the tip's). The HUD string is
  untouched.
