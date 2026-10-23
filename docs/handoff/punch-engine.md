## Punch - engine (2026-10-20)

Write-up: `docs/PUNCH.md`. Files: `nso_punch.js` (new, THREE-free, not on the
page: no UI yet, so no `index.html` line and no `?v=`), `tools/nso_punch_test.js`
(`npm run punch:test`, in `testSteps`, weight 600).

`NSO_Punch.plan(soup, hit, opts)` -> `{ ok, holes: [{centre, axis, dia, depth}],
reason }`; `NSO_Punch.cutters(plan)` -> one cylinder soup per hole. Three things
to keep:

- **The axis is the smooth normal at each footprint**, not the facet's - a grid
  on a 64-facet tube is radial to 0.0001°, where the facets are off by up to 2.8°.
- **Off the face is dropped and said, not refused**; a footprint must be on the
  click's own smooth surface, so a grid hanging over a step drops those holes too.
- **The wall floor (two nozzle widths) is measured in material only**: between
  holes over their material spans, to the edge at convex rims only, and the skin
  under a blind hole.
