## Threads - tapped holes in Punch, threaded pipe/fitting ends, a rod / bolt / nut generator (2026-11-05)

Write-up: `docs/THREADS.md`. New: `nso_thread.js` (the engine: a helical thread built directly as a closed, wound-outward mesh and clipped
to flat planes - no boolean; rod, bolt, nut, fitting, sleeve, cutter), `app-fasteners.js` (Gen+ > Fasteners), `tools/nso_thread_test.js`
(`thread:test`, 214 checks), `tools/nso_punch_thread_test.js` (`punch:thread`), `tools/nso_fittings_thread_test.js` (`fittings:thread`),
`tools/nso_fasteners_drive_check.js` (`fasteners:drive`). Changed: `nso_punch.js` (`thread` option: the hole's Ø is the thread's, a threaded
cutter), `app-punch.js` + the Punch card (Thread select, Left-hand, read-only Ø), `nso_fittings.js` (`threadEndFromTube`, the splitter's
`trunkEnd` / `branchEnd`, the tube reader shared with the cap), `app-fittings.js` + the Fittings card (Thread / Thread 2 / T length / T fit,
Tube end male / female, Nipple / Coupler / Adapter / Plug / Screw cap, Trunk end / Branch ends; it also exports `nsoFittings.addPiece`, the
drop Fasteners shares), `index.html` (the Fasteners menu, two script tags + `npm run stamp`), `tools/nso_punch_drive_check.js` (9b) and
`tools/nso_fittings_drive_check.js` (6b), `package.json` + `tools/test-weights.json` (four steps), `README.md`, `docs/PUNCH.md`,
`docs/FITTINGS.md`.

Things worth knowing:
- *The 1e-4 weld.* `mesh_validate.py` and the app's repair weld at 1e-4 mm. The thread's rows land on a rational lattice of the pitch, so a
  vertex was often 1e-6 off a clip plane and its crossing point 1e-6 from it: float32 and the weld merged them into slivers (non-manifold edges,
  inconsistent winding on only the *pipe* pieces, which clip at more planes). The fix is in the engine: a vertex within `SNAP` = 3e-4 mm of a
  plane is moved onto it. Do not shrink it below the weld radius.
- *A hex outline of 6 points cannot be walked to a small bore.* The annulus between two loops is walked by angle; one 60 degree hex edge
  became a chord that crossed a Ø8 bore (26 piercing pairs on the nut). Polygons are cut into collinear pieces (about 120 points round) so the
  two loops have similar density - the same shape, no T-junction (the side wall is cut the same way).
- *Hand under a rotation.* Punch maps the cutter by (e1, -e2, -a), a half-turn, not (e1, e2, -a), a mirror that would flip every thread's hand.
  `punch:thread` 4g mates a rotated Fasteners bolt into a hole on a +X face; an earlier draft of that test used a mirror and failed
  correctly, which is how the mistake was found.
- *The flow bore of a threaded fitting.* A bore between a female thread's crest and root radii crosses the step outline; the engine refused
  it (`internal: two outlines at a step cross`) in the drive check's adapter. The bore is now held a wall's worth under every male root and
  female crest, and a typed one that cuts into a thread is refused in words.
- *A male splitter end must bite into the wall.* The first version added a spigot that sat entirely inside the run's bore: two bodies. The
  thread's root must reach 0.8 mm (2 nozzles) into the wall's ring; the refusal gives the bore that would work.
- *Not in the ticket* (docs/THREADS.md, "Flags"): single-start only, no chamfer or lead-in, flats wider than the standards', G / NPT are
  printable threads not gauged ones (tape them), the fit is one number (0.2), no left-hand in the Fittings card, a 60 degree thread's lower
  flank is 30 degrees off horizontal when standing on end.
- *Running the drives here.* The harness wants `node_modules` (`npm ci`) and a Chromium: `PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`.

Follow-up, same day - **Fasteners: tiles, sliders, live preview** (`app-fasteners.js` rewritten, `app-fittings.js` gains `nsoFittings.spotFor`,
`styles.css` `.fs-tiles` / `.fs-slider`, the Fasteners block in `index.html`, `tools/nso_fasteners_drive_check.js` rewritten for the new flow):
- The four buttons are now **tiles** that choose a kind; the heads are two more tiles; **Add to plate** bakes. Every number has a slider
  (`nsoLiveSlider`); the old verbs live on as `nsoFasteners.rod() / bolt() / nut() / set()`.
- *The preview is not a piece.* It is a `THREE.Mesh` added to `state.scene` (flagged `userData.nsoFastenerPreview`), never to `state.modelGroup` or
  `state.placed` - picking intersects `modelGroup.children`, the packer and the export read `state.placed`, and Undo is only pushed by `addPiece`.
  The drive check asserts all three. It stands where the drop would: `spotFor` runs `wantedSpot` then `nsoFreeSpot` with the ghost's own mesh as the
  entry, so the free-spot search measures the real footprint. After a bake the drop's search must not see the ghost, so it is cleared first and
  rebuilt beside the new piece.
- *"Untouched" numbers.* Ø / Pitch / Nut thick start at the size's own and are only passed to the engine when moved off it (G1/2 is 20.955; the box
  shows 20.96). `nso_thread.js` names an overridden thread by its numbers (`M7x1.5`), so a piece made from a moved slider is not called `M8`.
- *Tiles reuse `nsoStockShelf.paint`* (the Stock shelf's 2D painter) - no image files; if a shelf is not loaded the canvases stay blank and the
  card still works.
- The menu body is a wrapping flex box 176-320 px wide: a row that is not `flex: 0 0 100%` sits beside its neighbour (the first layout interleaved
  the two tile rows).
