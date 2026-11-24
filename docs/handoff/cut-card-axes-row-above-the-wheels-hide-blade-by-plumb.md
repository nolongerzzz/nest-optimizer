## Cut card: the Rotate axes are one segmented row above the wheels; Hide blade sits under Plumb (2026-11-18)

Write-up: `docs/CUT-BLADE.md` (Rotate). Fourth pass condensing the Cut card; the aim is to keep the controls on a page without a scroll.

- **Rotate axes** (Horizontal | Front/back | Side/side): the three one-at-a-time checkboxes stacked under the Rotate wheel's - / + (84 px) are now a
  full-width segmented row directly above the wheels (`.cut-rotate-axes` / `.cut-seg`, class `cut-per-piece` so Whole plate hides it as before). The
  inputs keep their ids (`chk-cut-rot-h` / `-fb` / `-ss`) and are still checkboxes the JS ticks one at a time (`cutWireRotateDial`); the checkbox is
  laid invisibly over its segment and `:checked` lights it, so nothing in app-cut.js changed. The stack had made the Mitre / Rotate row 224 px tall with
  58 px dead under Square / 90; the row is now 166 px.
- **Hide blade** first moved under Plumb, then (the owner: it could stay up where it was) went back to its own row under the Blade block, above the axes
  row - made possible by reclaiming the dead air above the Blade row: the toggle's 8 px margin + the card's 6 px gap + `.cutter-tools` 8 px + `.cut-blade`
  6 px + `.edit-row`'s 8 px (the status lines they spaced are empty now). The top rows are now spaced by hand (`#edit-card .cut-blade-mode`, `.cut-hide`,
  `.cut-rotate-axes`, `.cut-seg`) because the global `.edit-row` / label margins (8 px each) added a row's worth of air.
- Net: the Blade row is 14 px under the Cut | Crop switch (it was 30), and the card is 64 px shorter than before this pass; the Cut button's bottom edge,
  with Chop / Notch / Dice open, went 776 / 947 / 1091 -> 712 / 885 / 1027 px (Dice with Follow strand is still taller than a 994 px page; the card
  scrolls inside itself).
- Tried and dropped: the three segments in the Hide blade row (215 px of text beside a 79 px label does not fit in the 278 px card).
- Tests: `nso_cut_rotate_dial_drive_check.js` (axes above the wheels in one row, Hide blade under the Blade block), `nso_cut_plane_drive_check.js` (the Blade row is close under the toggle), `nso_wire_cut_redesign_test.js` (control order).

Further room, not taken: the Bevel - / + under its wheel could sit in the free column beside it (about 40 px more).
