## Cut card: the Bevel wheel is a half wheel, in the Mitre / Rotate columns (2026-11-19)

Write-up: `docs/CUT-BLADE.md` (The three wheels). Fifth pass condensing the Cut card.

- **Half wheel.** The bevel only swings -90 .. 90, so the dial is its top half: viewBox 100 x 58 (was 100 x 100), the rail an arc (`M10 50 A40 40 0 0 1 90 50 Z`),
  the blade a needle from the pivot (50, 50) up, the flat edge the piece's own line with its arrow. Same ids and the same `rotate(deg 50 50)` groups, so the
  sync code is unchanged. The number input sits in the half disc (`.cut-halfwrap`, top 36 px, 48 x 21).
- **Pointer pivot.** `cutWireBevelDial` took the middle of the SVG box as the pivot; on a half wheel that is the wrong place. It now reads (50, 50) through
  `getScreenCTM()`, so a drag turns the blade by the pointer's turn about the real pivot (`nso_cut_bevel_test.js`'s real-mouse drag pins it).
- **Layout.** The Bevel block is a `.cut-dials` grid like Mitre / Rotate: the wheel in the left `.cut-dialcol` (its left edge now lines up with the Mitre wheel; before,
  it started at the card's edge), its - / + and Plumb in the right one, under one another, lined up with Rotate's - / + (Plumb as wide as the pair: 100 px).
  The old `.cut-miter` grid / `.cut-miter-side` rules for the Bevel row are gone (the Mold card keeps its own).
- Net: the Cut button's bottom edge with Chop / Notch / Dice open went 712 / 885 / 1027 -> 635 / 808 / 950 px: Dice with Follow strand now fits a 994 px page.
- Tests: `nso_cut_rotate_dial_drive_check.js` (half wheel, aligned with Mitre, - / + and Plumb lined up with Rotate's), `nso_cut_bevel_test.js` (pivot at (50, 50) of the
  box), `nso_wire_cut_redesign_test.js` (order: wheel, number, - / +, Plumb).

Not taken: the Rotate column still has a 34 px empty slot beside Square / 90 degrees (Mitre's second row); the Bevel - / + could use it, at the cost of sitting away from their wheel.
