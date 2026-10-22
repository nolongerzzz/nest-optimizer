## Lift keeps an assembly together (2026-10-15)
Branch `claude/lift-assembly`, off `claude-wip` after #191. Full write-up:
**`docs/LIFT.md` §8**.
- **What changed:** a lifted feature brings the shells it captures - a hinge's
  leaf, a ring on a post, a pin in a bore - as ONE piece with several shells,
  gaps as they were, not fused. Captured = a shell not connected to the base
  body whose box lies within the feature's box inflated by 2 mm, or overlaps it.
  The parent is repaired only where the feature stood; one Undo restores both.
  Pick, Shift-click and Strip all honour it. The card says "1 feature found —
  a line with 1 captured part".
- **Engine:** `nso_lift_auto.js` `assemble` (end of `analyse`): shells by edge
  adjacency, capture, a held shell's own island dropped, `I.parts` /
  `I.partCount`; `cut` appends the held shells' triangles to the piece and
  removes them from the plate. New refusals in words: `floating` (a shell
  nothing holds - it used to borrow `loops`) and `capture` (a held shell that
  is not closed). Pieces with one shell are bit-identical to before.
- **Card:** `app-lift-plate.js` - count line, read-out, hover, Strip rows and
  the lift message say it; hover/Shift/Strip fills cover the held parts. The
  HUD is cleared when the card changes face (it kept the last face's text).
- **Checks:** new `lift:assembly` (64 gates; the hinge, a posts plate, a plate
  with a lone floating shell; the 3MF export of a lifted piece is one object
  of several shells). `lift:any-face`: nine assertions on the hinge wall's
  words updated (the leaf is no longer "can't be lifted"; the card says what
  it holds); the rest unchanged and green. `lift:plate` unchanged and green.
  Not re-run for this change: `lift:test`, `lift:auto-test`,
  `lift:curved-test` and the other drives (single-shell pieces take the old
  path unchanged).
- **The ticket's numbers:** it expected the hinge to give 2 captured parts and
  a piece of 3 shells. `feature-hull_hinge.stl` has TWO shells in all, so it
  gives 1 captured part and a piece of 2; the 3-shell case is the posts
  fixture's post A. The card says "a line with 1 captured part", not "a
  hinge": Lift names no features (§1).
- **Tags:** `nso_lift_auto.js` and `app-lift-plate.js` -> liftassembly1.
