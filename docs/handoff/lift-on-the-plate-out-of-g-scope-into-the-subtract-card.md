## Lift on the plate - out of G-scope, into the Subtract card (2026-10-15)
Branch `claude/lift-to-plate`, off `claude-wip`. Full write-up: **`docs/LIFT.md` §7**.
- **What changed:** where and how Lift is driven; the engine (`nso_lift.js`,
  `nso_lift_auto.js`, `nso_lift_curved.js`) is untouched. Subtract's Lift is
  now a verb on the plate (`app-lift-plate.js`): arming it on a selected piece
  runs the rolling ball once (cached per soup), the card says "N features
  found"; hover outlines, a click lifts, Shift-click gathers and lifts on
  release, Strip lifts everything after an untick list; one Undo each.
- **G-scope:** the row is **Features**, read-only (`app-gscope-lift.js`
  rewritten): outlines + the grouped list from the card's cache. No Pick base
  face / Lift / Remove / Clear choice / slider.
- **Dropped from the UI:** Remove (throw details away) and Phase 1's
  click-a-flat-face base. Both engines' functions are unchanged and still
  covered headless (`lift:test`, `lift:auto-test`).
- **Gone:** `app-shell.js` (its one button was "open G-scope at the Lift row")
  and its `.ms-row-target` style.
- **Paint scope:** Lift row moves to `app-lift-plate.js` (whole-piece);
  Features is none.
- **Checks:** new `lift:plate` (the Barocke plate fixture, 1280 x 800).
  `lift:drive`, `lift:auto-drive`, `lift:curved-drive` re-pointed at the plate
  and the read-only row. Static references updated, not run on this ticket:
  `shell:v3`, `ui:shell`, `paint:scope`, `helpers:teardown`.
- **Tags:** `app-core.js` helpmrg1 -> liftplate1, `app-gscope-lift.js`
  helpers1 -> liftplate1, `app-lift-plate.js` new at liftplate1,
  `styles.css` shellv3scale1 -> liftplate1.
