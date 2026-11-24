## Supports advanced - the tree rests on the part; Advanced numbers and Saved settings on the card (2026-11-14)
Branch `claude-wip`. Engine: `nso_support_flow.js` (`rest`, landings, `buildField` + the kept field, `candidates` / `pick`), `nso_support_gridpack.js`
(`planFlow` rest / `flowKnobsOf` / `FLOW_KNOBS`, `flowShells` one support by nearness, `flowParts` the lattice of the part's distance and the bottom
distance), `nso_slicer.js` (ring lines only under a stack of their own). Card: `app-supports-card.js` + `index.html` + `styles.css` (Advanced, Saved
settings, one plan a piece). Fixtures: `fixtures/supports/supporttest.3mf`, `supporttest_slim.gcode.3mf` (the owner's, printed twice). Gates:
`npm run support:settings` (new, in `testSteps`), `support:flow` (rest cases added), `support:gate-rest` (new, by hand). Docs: `docs/SUPPORT-FLOW.md`
4b / 4c, `docs/SUPPORTS-CARD.md` 10.

- **The owner's ask:** Bambu's slice of Supporttest (tree, `support_on_build_plate_only` off, threshold 46) printed well twice; NSO's "May rest on the part"
  gave 8 supports with the lattice's pillars. And: the planner's levers were constants in the code - "advanced settings on the card, so I can save what works".
- **The tree lands on the part** (a landing on any top face, counted by the reach field as the plate is); one plan a piece; one support where areas stand
  within 12 mm, supports of their own where they stand apart. Supporttest: 1 support, 13 s (was 8, 25 s), `support:gate-rest` 10 of 11 against the printed
  slice (tree over air 18 mm2, Bambu's 31; nothing floating; tree path 10 % under Bambu's). The one failure is the interface's edge touching at one step
  (1.35 mm2), the slicer's stack rather than the tree.
- **Advanced** (ten numbers) and **Saved settings** (every lever of the card under a name, in the browser, Export / Import as a file): section 10 of
  docs/SUPPORTS-CARD.md. A card left alone sends nothing new: `support:gate` 66 of 66 per head and `--merged`, as before.
- **Found, not changed (ask first):** the Slice section's own support threshold (30) is not the card's Angle (35; the owner printed at 46). The slicer lays
  the interface's footprint at ITS angle. `support:gate-rest` passes the card's angle to the slicer; the page does not. It belongs to the print / prep card
  the owner named - every lever in one place, supports an option of Slice - which is not started here.
- **The real page:** `npm run support:settings-drive` (new, in `driveSteps`): the controls are there, save / move / pick / reload put every control back,
  and May rest on the part at 46 deg builds the Supporttest as one support in the build worker (27 s in this box's Chromium). 11 of 11 here, with
  `CHROME_PATH` set to the box's browser. The other page drives were not run.
