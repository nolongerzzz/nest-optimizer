## Cut card: Mitre and Bevel numbers in the wheel centres, wheel names at the top-left corners, instructional text gone (2026-11-18)

Write-up: `docs/CUT-BLADE.md` (The three wheels). Second pass condensing the Cut card (the first made Rotate piece's number its wheel centre).

- **One helper for all three wheels.** `cutWireDialInput(id, { read, apply, nudge, sync })` in `app-cut.js` makes an input over a wheel's centre
  the wheel's number: click selects, typing replaces, Enter / blur commits, Esc reverts, Up / Down step. Mitre, Bevel and Rotate use it
  (Rotate's own copy from the first pass is gone). It commits on `change` too, comparing with the wheel's current reading (not a remembered
  one), so a script that sets the box and fires `change` still works. A box that cannot be parsed puts the reading back (the old Mitre / Bevel
  boxes turned junk into 0).
- **Gone:** the Mitre and Bevel number boxes, the SVG `<text>` readouts (`cut-dial-deg`, `cut-bevel-dial-deg`), the `.hint` name lines under the
  wheels, `.cut-dialfields`, and the status line's "Click a piece to drop a square blade on it." (`#cutter-status` is empty and hidden by `:empty`;
  the Whole plate line is kept - it names the mode and `nso_cut_plate_drive_check` reads it).
- **Moved:** each wheel's name is a `.cut-dial-label` at its wheel's top-left corner ("Rotate piece" is now "Rotate"; the aria labels still say
  Rotate piece). Square and 90 degrees sit side by side under the Mitre - / +; Plumb sits beside the Bevel wheel where its box was.
- Tests: `nso_cut_rotate_dial_drive_check.js` (layout gates for all three wheels, labels, empty status line, no hint lines, typing in the Mitre and
  Bevel centres), `nso_wire_cut_redesign_test.js` (control order; the Mitre text is the box; also now lists `cut-notch-from` / `cut-notch-to`,
  which it had been missing), `nso_cut_bevel_test.js` (`-12.5°`, not `-12.5`).
- `nso_shell_v3_test.js` fails 3 gates (menu-supports controls, CLEAR PLATE) with and without this change.
