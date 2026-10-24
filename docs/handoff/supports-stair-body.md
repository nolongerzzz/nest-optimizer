## Supports stair body - each strip covers the part's step (2026-10-24)
Branch `claude/supports-stair-body` (PR #275), rebased onto `claude-wip` 274b8bd.
`nso_support_interface.js` (THE STAIR), `nso_support_gridpack.js` (the landing,
`weld()`), `nso_slicer.js` (`typeSupports`), `tools/nso_support_curved_check.js`,
`tools/nso_support_foot_check.js`, `tools/test-weights.json` (`support:curved`
46000 -> 63000), `.gitignore` (`tools/supports-stair-out/`), docs.

- **Strips.** Each is as wide as the part's step over it (the next layer's
  advance) plus one line, at least two lines; the sheet's own lines (0.40 at
  0.84); kept to the outline plus one line, the top strip spread to it. #265's
  stair tree holds the leading part: a tip every 5 mm or nearer. `support:curved`
  gates: width >= step + line, gap 0.18-0.55 (median <= 0.35) where the next
  layer is not over it, no strip span longer than the tip pitch, material over
  the stair's start <= 1.5x Bambu's. The whole part's ratio is a printed
  finding owned by the trunk-thinning follow-up.
- **Overhang reading.** `typeSupports` gives every support path `overhangMm` and
  `overhangRuns` (typing only; the G-code is the same).
- **Trunk landing.** Bambu's trunk foot stands 3.86 mm off the part's base on
  layer 1 (measured in `simple_overhang_bambu.gcode.3mf`). On the card's build
  (trunks grown) a trunk that would stand nearer, or whose law would not fit up
  its stem, is re-landed within the plan's branch lean. Without trunk growth
  nothing moves.
- **Two weld findings, both in `weld()`, found by `support:shells` on the
  tilted box** (a stair 80 strips, 474 tips, 186 stair trunks):
  1. *"sheet 10 does not meet the tips it was built on".* The sheet met them.
     The union was one solid plus 45 voids of 0.003 mm3 or less sealed between
     the tree's legs and the strips; the kernel's merge test counts every closed
     surface as a part (53 out of 4 + 1). Where it says "do not touch", the
     result and both inputs are counted again as solids (positive volume); the
     join stands when that count fell (`solidsIn`, `merged`).
  2. *The hole.* After 1, `support:shells-fixtures` failed 54 of 55: 10 sections
     (z 8.5-10.3) of the tilted box with one more hole in the shells than in the
     weld. It was a 0.12 mm2 pocket between the legs of five stair-tree trunks
     (96, 103, 108, 114, 245), x 19.1-20.4, y 23.1-23.5, z 7.3 up to the sheet,
     pinched to 0.015 mm at its neck - the legs only graze, the unions of
     their trunks said "do not touch", so `weld()` handed the kernel the four
     solids concatenated as one soup next to the sheet. The kernel's own slice
     of that soup plus the sheet has the pocket cut by a 0.08 mm wall
     (0.057 + 0.036 mm2 in two holes); the same solids united ONE AT A TIME
     first have it whole (0.122). The strips are not in it: the sheet has
     nothing at z 8.7 there, and #274's head has the same crowd (480 tips, a
     nearest neighbour 0.70 mm). The fix is `stackUp()` in `joinSheets()`:
     the carriers go through the kernel one by one, then the sheet is added to
     the result. Shells and weld now have the same islands and holes at every
     layer; `tools/nso_support_shells_check.js` is untouched.
- **Card export.** The tilted box exports as one support object holding all 120
  spots; its sheet meets its carriers (checked on the weld).
