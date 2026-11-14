## Supports: Bambu's Advanced rows - on the card, in the slicer, in the file (2026-11-14)
Branch `claude-wip`. Card: `index.html` `#sup-bambu-sec`, `app-supports-card.js` (`BAMBU_TREE`, `bridgeNow`, `nsoSliceRowsSeeded`), `styles.css`.
Settings: `app-print.js` (`SUP_ROWS`; `seedSettings` tells the card). Slicer: `nso_slicer.js` (nine new options). Gates: `npm run slicer:support-levers`
(26), `npm run support:advanced` (28), both in `testSteps`; `support:settings` (21); `support:settings-drive` (the real page, 14). Doc:
`docs/SUPPORT-ADVANCED.md` (the table: every row, Bambu's key, where it starts, who reads it).

- **The owner's ask:** Studio's Advanced support block (17 rows, a screenshot) "enabled on the slicer, and added to the supports card".
- **Done:** all 17, by Bambu's names and in its order. Six were options the slicer already had and no card showed (top Z, xy, interface spacing, pattern
  angle, interface layers, independent layers); nine are new in the slicer (wall loops, base pattern and its spacing, interface pattern, bottom Z, Z
  overrides X/Y, first layer density and gap, expansion); two are the tree's and the detector's (initial layer expansion = the pad, max bridge length).
- **Nothing moves until a row is touched:** each row starts at NSO's own value (top Z 0.18, first layer solid, bridge 5 mm - Bambu's are 0.2, 90 %, 0), and
  an untouched card slices the same G-code line for line. To print Bambu's numbers: type them and Save.
- **The earlier "Advanced" is "Tree planner"** now; its Foot pad, Part clearance and Bottom distance became Bambu's rows (one lever each).
- **A bug the page drive found:** the Slice rows are re-seeded from the profile on load, so a saved setting lost them on reload. The card lays them back
  (`nsoSliceRowsSeeded`); Reset in the Slice section clears the saved setting shown.
- **Normal Support expansion** has nothing to widen in a tree build; here it moves the interface's reach past an overhang's edge. Honeycomb / Lightning base
  patterns are not offered. G-scope's own Slice settings do not have the rows.
