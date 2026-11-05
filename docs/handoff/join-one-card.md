## Join - one card (join-one-card, 2026-10-22)
The owner's ask (2026-10-21): one JOIN card, all options. The Join and A-B-C
sub-menus are merged into one card (docs/JOIN-TRIPLE.md, "The card").
- **The card.** The Vertical / Horizontal toggle is on top. Below it come
  the A, B and C slots, with a gap row (checkbox + slider) between each pair
  of slots, then JOIN and Cancel, then a readout line. Checkbox off: that
  junction is seated touching (0) and its slider is greyed. Checkbox on: the
  slider's value, -0.25 to +0.05, default -0.18. The B-C row is disabled
  until C is picked.
- **What JOIN runs.** With two pieces and the A-B gap off, it runs Complete
  Join (`joinSelectedModels`), unchanged. With two pieces and the gap on, it
  runs the A-B junction alone (the triple's first junction). With three
  pieces, it runs both junctions. Cancel clears the slots. The toggle and
  the gap rows keep their setting.
- **One press, one Undo.** `app-core.js` gets a `stepGroup` undo entry:
  JOIN's lock/seat steps are kept as they were made and undone last first.
  This is the only change outside the ticket's file list, made for the
  "Undo one step" gate.
- **Removed ids:** `menu-join`, `menu-abc`, `triple-join`, `triple-mode`,
  `triple-gap-ab(-value)`, `triple-gap-bc(-value)`, `btn-join-triple`. The ids
  `btn-join` and `btn-join-clear` stay, so every check that clicks Complete
  Join or Cancel Join is unchanged.
- No boolean or seat engine change. `?v=onecard1` on `styles.css`,
  `app-core.js`, `app-join.js` and `app-join-triple.js`.
- Checks: `join:triple` sections 1-12 are re-pinned to the card (one Undo per
  press). Sections 13-18 are new: Complete Join vertex for vertex, the pair
  vs the triple's first junction, off = 0 per junction in both modes, the
  card, Cancel, and shots to `tools/join-card-out/`. `shell:v3`,
  `ui-shell`, `leave-tool` and `qa:tour` now name the card's ids instead of
  the removed ones. shell v3's member-in-drop-down check uses Gen+ / Photo,
  the one merged drop-down left.
- `testStepWeights` `join:triple` 69850 -> 150000 (151 s on this box with sections 13-18).
