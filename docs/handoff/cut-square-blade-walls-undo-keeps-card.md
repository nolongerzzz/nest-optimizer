## Cut: a blade square to the walls, Undo keeps the card open and the blade where it was, 3MF import with the card open (2026-11-20)

Write-up: `docs/CUT-BLADE.md` (The square blade, and Undo). From the owner's Desk Side Hanger 3MF (`Körper8`, the clamp with the hanger on its bottom).

- **The blade loaded 29.7 degrees off while the card said "square".** The frame is the footprint's narrowest rectangle unless the rectangle square to the
  piece's body axes is within 2% of it. The bracket's box along its axes (96 x 99) was 7% bigger than the narrowest (128 x 69, on the diagonal), so the diagonal
  won. `nso-bounds.js` gains an opt-in, `pieceFrame(p, { walls: true })`, used by `cutTravel` only: the horizontal run of every steep triangle's edges is a
  histogram by direction (cached per geometry); if >= 30% of it is along the body axes (+-2 degrees) and the body box is <= 1.3x the narrowest, the body is the
  frame. On the hanger 47% of the wall length is along the axes and 3.6% along the diagonal. A bar modelled on a 30 degree slant has its walls along the bar
  and keeps its hull frame (gated). Rotate, Bend, Scale, Join etc. call `pieceFrame(p)` and are unchanged.
- **Mitre 29 / 30 on that piece**: the mitre is measured from that diagonal, so +29.7 degrees squared the blade (normal (0, 0, 1), span 99) - the right angle,
  but not one anybody should need. A sweep of Chop every 3 mm along the whole piece at 29.7, 30 and 29 made 99 cuts and refused none; the owner reported a
  refusal "even on edge" that I could not reproduce. Not understood; ask for the status line text if it recurs.
- **Undo of a cut kept closing the card.** The `splitReplace` Undo set `cutterOpen = false`. A cut made with the card open now stores `cutMemo`
  (`cutBladeMemo`: place, mitre, bevel, the blade) on its Undo entry (Chop in app-join.js, Plane in app-cut-plane.js); Undo leaves the card open, selects the
  piece and calls `cutRestoreAfterUndo`. A cut made with the card shut closes it as before. `nso_undo_redo_test.js` compares the whole plate bit for bit: its
  Cut round trip now ignores which piece is selected (it is selected again).
- **A 3MF imported with the card open** (an import that keeps the file's positions, `options.at`) is put down where the file says, no lone preview of the last
  object (found while reproducing; my import fix had made the last object the preview).
- Tests: new `nso_cut_square_drive_check.js` (`cut-square:drive`: the bracket square, the slanted bar not, Undo keeps the card and the blade for Chop with a mitre
  and bevel and for Plane, a card-shut cut still closes it); `nso_cut_plane_drive_check.js` (no reopen after Undo); `nso_undo_redo_test.js` (selection).
