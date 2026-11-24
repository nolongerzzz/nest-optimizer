## Cut card: Blade block at the top (Chop / Dice / Notch / Plane, Whole plate on its own row), the Plane blade, Rotate label gap, import-with-card-open fix (2026-11-18)

Write-up: `docs/CUT-BLADE.md` (the Blade block; Plane). Third pass condensing the Cut card.

- **Blade block moved to the top**, first thing in `#cutter-tools` under the Cut | Crop switch, with every field row each blade opens under it.
  Buttons renamed (text only; ids and modes `full` / `sized` unchanged): Full blade -> **Chop**, Sized blade -> **Dice**, Notch as it was.
  **Whole plate** is one thin full-width button on its own row (`.cut-blade-plate-row`) under the four.
- **Plane** (new, fourth button): `app-cut-plane.js`. Chop's blade with one side thrown away - the NEARER end comes off, the cut face is capped
  flat, one piece is kept in place under the same name, one Undo. No 1 mm minimum: `cutEndLimits` (app-cut.js) uses `CUT_PLANE_END_MM` (0.1) while
  `cutPlaneOn()`. It reuses `cutSplitAt` (so mitre and bevel work) and keeps one half; `layoutAfterSplit` gained a `noGap` argument so the kept
  half is not parted from where it stood. Press path: `cutActiveModel` (app-join.js) hands off to `cutPlaneRun` before its 1 mm checks. Written for
  the 0.16 mm needles a thicken repair left on a piece's end faces (the piece in the session that asked for it).
  Assumed, not asked: the removed end is the nearer one and is not kept as a piece. Say if either should change.
- **Rotate label** is 5 px further out (`.cut-dial-label-long`): the word is longer, so its gap to the rail was 4 px against 9.5 (Bevel) and 11.6 (Mitre).
- **Bug fixed: a piece imported with the Cut card open was never shown.** `placeNewModel` (app-core.js) called `showEditPreview()`, which shows
  `getActiveModel()` = `state.editId`, and nothing set it on an upload: the plate stayed empty, the slider sat at its end, Cut was off, and the status
  line still said "cutter open, slide red plane". It now sets `state.editId = id` first and refreshes the list, the size line and the cutter UI. Found
  by the owner; present as far back as this clone's history goes (not caused by the card passes).
- Tests: new `nso_cut_plane_drive_check.js` (`cut-plane:drive`: layout, import with the card open, Plane limits / either end / closed / Undo / mitre,
  Chop unchanged). Updated: `nso_wire_cut_redesign_test.js` (card order), `nso_cut_plate_drive_check.js` (the row), `nso_cut_rotate_dial_drive_check.js`
  (label offset), `nso_cut_follow_drive_check.js` (the slider is scrolled into view before it is dragged).

Things worth knowing:
- With the Blade block at the top, a blade that opens rows (Dice's three sliders and Follow strand, Follow's Slice / Back / Forward) pushes the slider,
  the mm box and Cut down the card: on a 900 px page they are inside the card's own scroll while those rows are open.
- Undo closes the cutter (every Cut does), and opening it again starts on Chop: after an Undo, Plane has to be pressed again.
- A Plane lands on the 0.1 mm grid: 0.2 mm from an end face that carries a 0.16 mm needle takes the needle and 0.04 mm of real face.
