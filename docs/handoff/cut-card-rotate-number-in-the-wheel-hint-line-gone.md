## Cut card: the Rotate piece number is the centre of its wheel; the blade-placed hint line is gone (2026-11-18)

Write-up: `docs/CUT-BLADE.md` (Rotate piece). First of a few passes to condense the Cut card.

- **Rotate piece number in the wheel.** The readout in the middle of the wheel is now an input (`#cut-rotate-deg`, `.cut-dial-input`, laid over the
  rail in a `.cut-dialwrap`), so it shows `45°` as the wheel turns and a click types one. The separate number box under the wheel is gone.
  Enter or leaving it sets the piece (one Undo point, the old `change` path); Esc puts the reading back; Up / Down step 1 degree (Shift 0.1).
  `app-cut.js` `cutWireRotateDial` / `syncCutRotateUI`. The SVG `<text id="cut-rotate-dial-deg">` is gone. The Mitre wheel is unchanged (its box
  sits beside Square / 90 degrees).
- **The hint "Click the piece to move the blade; slide, nudge or angle it, then Cut." is gone.** `#cutter-status` is now empty in that state and
  hidden (`:empty`), so it takes no room. The other two states ("Click a piece to drop a square blade on it.", the Whole plate line) stay.
- Tests: `nso_cut_rotate_dial_drive_check.js` (layout gates now say the number is the wheel's centre; new gates for click-to-type, Enter, Esc,
  Up / Down; the box reads `20°`, not `20`), `nso_wire_cut_redesign_test.js` (control order: the number follows its wheel).

Things worth knowing:
- *Do not rewrite the input's text on focus.* A first version stripped the degree sign in a `focus` handler; under Playwright's `fill` (and possibly
  a real click when the window is slow to take focus) the rewrite landed after the selection and `0` typed over `50` came out `500`, so the
  drive check failed differently on every run. The text is left alone, the whole reading is selected, and the blur handler ignores the degree sign.
- `nso_wire_cut_redesign_test.js` already failed before this change at the same control-order check: the card has two inputs
  (`cut-notch-from`, `cut-notch-to`, app-cut-notch-span.js) that its expected list does not name. Not touched here.
