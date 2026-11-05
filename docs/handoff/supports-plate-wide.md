## supports-plate-wide - Supports card: Generate for plate (2026-10-26)

`app-supports-card.js`, `index.html` (`#sup-plate-row`, `#sup-plate`), `styles.css`. **The engine is not changed.**
Check: `npm run support:plate` (`tools/nso_support_plate_test.js` + `tools/nso_support_plate_lib.js`, Node only, ~4 min; the
card's own file run in a vm with the real engine and the app code it stands on lifted out of app-core.js /
app-sel-outline.js / app-join.js). Input: `fixtures/supports/supp_ref.3mf` (six real parts, added here). Behaviour and
the gap table: `docs/SUPPORTS-CARD.md` section 8.

**What it is.** With two or more pieces, an option "Generate for plate" under the Angle. On: every real piece is lit (the
selection's tint and outline, one outline per piece, in `p.outline`), each is detected, the readout is "6 pieces · 8
hanging areas at 35°". GENERATE loops the piece's build over the pieces in plate order: one bar ("Piece 2 of 6 · Planning
142 / 344 · 21 %", counts the piece's, percent the plate's), one commit at the end, ONE Undo step; Escape / the watchdog /
an exception leave the plate as it was. Rows name the pieces that need a look; a click on one selects and frames it.
Single-piece Generate is the same code (`build` is `startJob` + `runPiece` + `settleResults` + `placeResults` +
`finishJob`, and the plate's `buildWide` calls the same four); its output is byte-identical to 7dc1d1f's (gate 6: three
pieces' support bytes hashed on the unchanged card).

**Read this first: check 5 is not met, and it is an engine ticket.** Six parts as the app lays them out (a row, 4 mm
apart): supports vs other pieces' bodies **2.973 mm** (ok); supports of different pieces **0.293 mm** (five neighbouring
pairs: 0.305, 0.309, 0.293, 0.295, 0.295) against the slice's 0.35 mm `support_object_xy_distance`. Without this
feature's occluders (six single builds, one after another) the same pairs are **0.000 mm: they touch**. The occluders
get it from touching to 0.29; the rest is the first-layer pads, which keep `FOOT_GAP_MM = 0.2` mm off an occluder
(`nso_support_gridpack.js`, `footPads`, plus the raster's slack). 0.35 means changing that constant (or the raster's
keep-off): not done, per the ticket. The test prints it as `KNOWN-GAP` and does not fail; `NSO_STRICT_GAP=1` makes it a
failure, so the ticket that moves the constant flips one line. (In the fixture's own slicer layout, 24 mm apart, the
numbers are 16 mm and the question does not arise.)

**The ceiling.** `S.ceilingMs` (10 min) is read as per piece: `startJob`'s `arm()` is called again as each piece begins
(`buildWide`), `pause()` measures from it, and the message names the piece ("B was still running after 10 min"). The
watchdog is untouched: 60 s with no message, every message starting it again, so the plate's total never counts. Gate
3b shows both with the page's clock moved: three pieces of 400 s each (20 min, twice the ceiling) build; one piece of
11 min is stopped and named; 70 s of silence on one is stopped.

**Choices a reader may want to undo.**
- *Which pieces, in what order.* Plate order (`state.placed`); the earlier pieces' built supports are the later ones'
  occluders, so the first piece is the one that yields nothing. A piece the planner refuses (not ok, no spot inside the
  part) is reported and its old supports stay; an exception stops everything.
- *The highlight is the option.* `wideHolds` is checked every frame: anything that takes the outlines down (a piece
  picked, added, removed; an Undo that restores the plate; Clear plate; the card closing) ends the option. Off by the box
  puts the card back on the piece it was on. After a plate build the pieces stay lit; the Undo of it ends the option.
- *Big pieces.* The outline is the app's `refreshOutline`, which for a big piece (a worker draws it) is not drawn for a
  piece that is not selected: a big piece is tinted, not outlined, on the plate.
- *Modes.* The loop uses the card's mode and each piece's own feed; Assisted / Custom readouts count spots / tips and
  the tools row is hidden on the plate. A Custom piece with no tips is a row ("no tips"), not an error.
- *Not on the plate:* REMOVE ALL / REMOVE (per piece), area clicks, spots, circles, the eraser.

**Measured (six real parts, in-thread planner, this box).** 142 s for the plate. Per piece: Support Base 1 area, 1 support,
12,348 triangles, held 1, 29 s; Support Circular 1 / 1 / 448, held 1, 7 s; Support Negative Sphere 1 / 1 / 5,704, held 1,
32 s; Support Negative Sphere2 3 / 1 / 500, held 3, 2 s; Support Oblique 2 (one split off as lost) / 1 / 1,496, held 1,
**unreachable 1**, 64 s; Support Sphere 1 / 1 / 464, held 1, 7 s. "Built: 6 supports on 6 pieces · held 8 · unsupported 0 ·
unreachable 1", one row ("Support Oblique · unreachable 1"), one Undo takes all six back and the highlight with it. In
the real page (Chromium, the worker) the same build ran in 133 s with the same readout and rows.

**Not done / known.** The test's six-part gate is two minutes of real planning (`support:plate` weight 240 s, an estimate
until CI measures it). The check for the gap uses the plate's own layout, not a stress case. No browser step was added to
`testSteps`; `npm run support:workflow` (`--only=card`, `counts`) was run by hand and is unchanged.
