## Support flow - one program grows every tree; Tests #432 green again (2026-11-13)
Branch `claude-wip`. Engine: `nso_support_flow.js` (new, pure: `plan`, `prims`), wired through `nso_support_gridpack.js`
(`planFlow`, `flowParts`, `flowShells`, `FLOW`; `blobSoup`'s `cut.flat`; a foot's `padGrowMm`). Slicer: `nso_slicer.js`
(`COLUMN_TUBE_FILL_MAX_MM`, `COLUMN_TUBE_RING_MAX_MM2`; the one-wall-on-top rule kept off supports). Loaded in `index.html`, the
card's worker list (`app-supports-card.js` ENGINE) and `tools/nso_support_plate_lib.js`. Gates: `npm run support:flow` (new, in
`testSteps`), `npm run support:gate` and `--merged`. Doc: `docs/SUPPORT-FLOW.md` (the program, the numbers, what is left).

- **The red tip (Tests #432 shard 7, `support:feed` 5 of 89):** `99371f3` narrowed every crown trunk's shell to its body's radius;
  on a fed (Custom) crown that cut the trunk under Bambu's law and squashed its oval. The narrowing is now the column crown's alone
  (`trunk.meetBody`). `support:feed` 89 of 89.
- **Why the regressions kept moving:** Auto's tree under the column rule was a stack of rules - clusters, landing circles, joins by
  formula, a trunk shell under a smooth body, tip forks, horn routes, splits and re-plans - each tuned on one head. It is replaced
  there by one descent (docs/SUPPORT-FLOW.md section 2): tips go down level by level, pair up and join, keep to cells that have a
  way to the plate, and take their thickness from one law. No rule knows a shape.
- **Measured:** `support:gate` 66 of 66, per head and `--merged` (the six as one piece); tree over air 0.0 - 1.6 mm2 a head (was
  0.1 - 2.1); the tree's path 14 % under Bambu's over the six (-37 % .. +13 % a head); the owner's 2x Oblique one tree on one trunk (it stood two),
  8 % less tree path than Bambu's slice of it, built in 2.2 s. Unreachable 0.
- **Two slicer faults found on the way, both the owner's kind of print defect:**
  1. A support's first layer was printed hollow under its trunks whenever part of its pad lay open to the air (a pocket between
     trunks, a pad grown wide): the one-wall-on-top rule ran on supports and kept the fill to the exposed part. The trunks' second
     layer stood on nothing. Supports are left out of that rule.
  2. The ring lines under the stack crossed whole bodies of joined branches (hollow): lines over air. They cross a ring only now
     (a piece of 6 mm2 or less, a line of 2.6 mm or less).
- **Not changed:** the interface (column rule), Custom / Assisted (the fed crown), the sheet rule's build, struts, "may rest on
  the part". The old column-crown rules stay in `nso_support_gridpack.js` (the sheet rule and the fed crown share the code; Auto
  falls back to them only if `nso_support_flow.js` is not loaded).
- **Not run here:** the page drives (`driveSteps`). `support:card` and `support:workflow` were run by hand with the box's Chromium
  and fail on things this change does not touch (the angle default's text, the beacon discs); they were not compared against the
  tip. Run them on the runners before a merge.
- **Next:** Custom / Assisted on the flow planner (the circles as a pull); "may rest on the part" as a landing in the reach
  field; then the superseded crown rules can go.
