## Supports custom UI - Auto / Assisted / Custom on the card (2026-10-24)
Branch `claude/supports-custom-ui`, on `claude-wip` 274b8bd (#281 merged). UI only: `app-supports-card.js`
(the switch, the Tips / Circles / Erase tools, the markers, the feed it posts), `index.html` (the switch,
the tools row, the hint's id), `styles.css`, `app-core.js` (one line: Clear plate calls
`NSO_SUPPORTS_CARD.forgetAll()`), `tools/nso_support_custom_drive_check.mjs` (`support:custom`, new, in
`testSteps`), `tools/nso_pick_release_test.js` (a Supports row), `docs/SUPPORTS-CARD.md` section 6.

- **Auto is the card as it was**: no feed is sent, `support:workflow` 179/179 before and after.
- **Assisted**: the detected spots are points over the piece; a click turns one off or on (`beaconsOff`).
  **Custom**: no spots, a click on the underside places a tip, a click on a tip takes it away (`tips`).
  Both: `landingZones`, `excluded`. Custom plans its tips alone (no beacon list is posted with them).
- **One tool at a time holds the pointer** - Tips (default), Circles, Erase. Circles and Erase are
  start/stop switches (button, or Escape) so the view orbits freely when they are off: orbit to a good
  view, start Circles, draw, stop. A press on a marker is the marker's; anything else is the view's.
- **Circles**: drag on bare plate to draw (centre, then radius), drag the edge to resize, drag inside to
  move, click + Delete removes; each one Undo. **Erase** (after a build): hover lights the member and
  what it holds up (`carries`), nothing is said; a click puts its id in `excluded` and plans again (one
  Undo). Sheets and pads are not targets (the planner does not erase those alone).
- **State** is on the piece (`model.nsoSupportFeed`), survives REGENERATE, and is forgotten by REMOVE ALL
  (the card's reset; one Undo) and CLEAR PLATE.
- **Decided, not given by the ticket**: Assisted and Custom hide the outlined areas (the points replace
  them; left-out areas are Auto's and stay recorded); Shift-click adds a spot in Assisted and is a plain
  click (a tip) in Custom, and the Custom hint does not mention it; REMOVE ALL is the "card's reset";
  Erase is for tips, branches and trunks only; the new checks went in a new step (`support:custom`),
  not `support:card`, which is the superseded check.
- **Finding for the engine (#281)**: with the interface sheet on, its carrier trunks can stand ~1.7 mm
  outside a landing circle (2 of 192 trunk members on the tilted box, one 19 mm circle); `plan.trunks`
  are all inside.
