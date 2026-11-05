## No gate cards - Connect and Join open on the column button (2026-10-17)
Branch `claude/no-gate-cards`, off `claude-wip`. UI only, no engine.

- **Connect:** the column card held one button, "Connect" (`#btn-connect`), that
  opened `#connect-panel`. The button is gone; opening `#menu-connect` opens the
  card and arms the anchor picks (`NSO_connectOpen`), shutting it (column button
  again, Escape with nothing picked, Cancel with nothing picked, another column
  button, double-click on the plate) is `NSO_connectClose`. The `open` attribute
  is the switch, watched by a MutationObserver (`wireCard`, as the Cut and Crop
  cards are). Escape still drops the picks first.
- **Join:** `#btn-join-start` is gone. Opening `#menu-joins` runs
  `startJoinSession` and opens the Join card (`#menu-join`) in the same press
  (`joinWireCard`, `app-join.js`); shutting it with the column button or Escape
  is Cancel Join (`clearJoinSlots`). Cancel Join stays in the card and leaves it
  open; a slot click restarts the session (`armJoinSlot`, as before).
  **Two calls that are not in the ticket's wording:** (1) opening *another column*
  shuts Join but leaves the session standing, and re-opening Join keeps a live
  session instead of restarting it - Seat, Align and Center lock work on the A
  and B the Join card holds and need `state.joinSession` after Join has closed;
  tearing it down there would break Join -> Seat. (2) opening Join clears the
  selection, because `startJoinSession` always did.
- **Ids:** every id inside the two real cards stays; `#btn-connect` and
  `#btn-join-start` are the only ids removed. The eight refusals that said
  "Start Join, ..." now say "Open JOIN, ..." (app-join.js, app-center-lock.js,
  app-join-triple.js, app-seat-surface.js); `center_lock` and `flip_port` match
  the new words. Left as it was: the `#join-step` text '1. Start Join' in
  `updateJoinUI`, which has no element in the page.
- **Gate:** `page:manifest` section "column cards" - no `.vp-col-menu` whose body,
  outside the panel its one button points at, is that one button.
- **Tests:** `tools/nso_join_card.js` (`openJoin(page)`: column button, restarting
  if already open) replaces every `page.click('#btn-join-start')`: bring_to_plate,
  center_lock, face_select, flip_port, lift_plate_drive_check, multi_export_check,
  oversized_washer, poslock, seat_align, seat_box_on_box, seat_side,
  seat_tilted_face, skin_drive_check, wire_cut_redesign, join_triple, leave_tool.
  `watch_test` starts Join through `__G.joinStart`. `shell_v3`, `ui_shell_drive_check`
  and `flip_port` drop `btn-join-start` from their id lists; `shell_v3` skips a
  card already opened by the one before it and expects Join to clear the
  selection. `ui_shell_drive_check` and `topbar_accordion` count open drop-downs
  without the member inside one (Join's card opens with its column). `poslock`
  opens Seat before it folds the panels, since folding Join alone is Cancel Join.
  New sections: `connect:drive` 8, `join:triple` 12.
- **Run:** `connect:test`, `connect:drive`, `join:triple`, `wire:join-pose`,
  `shell:v3`, `leave:tool`, `page:manifest` all pass (they passed on the base
  too), plus every test edited above and `topbar_accordion`; not the full suite.
  `scene_roundtrip` failed once under six-way parallel load ("plate lock came
  back", a 400 ms wait) and passes alone.
- **Tags:** `app-connect.js` -> nogate1; `app-join.js`, `app-center-lock.js`, `app-join-triple.js`, `app-seat-surface.js` -> nogate2.
