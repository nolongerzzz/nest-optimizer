## UI cleanups - status panel, column menus on double-click, rotate screenshots (2026-10-13)
Branch `claude/ui-cleanup`, off `claude-wip`.

- **`setStatus` keeps the HUD panel.** It wrote `className = 'status success'`,
  dropping `status-hud`, so the viewport status line lost its dark panel at the
  first message. It now toggles only `success` / `error` (`app-join.js`; the
  dead `app.js` copy is untouched).
- **Double-click on the plate closes the left column's eight menus** (Join ..
  Pack, `.vp-col-menu`) as well as the top-row ones: `leaveTool` in
  `app-input-mode.js`. They own no input, so they stay out of `menus()`.
- **Rotate drive-checks write outside the repo.** `rotate:steady-drive` and
  `rotate:drive` default to a fresh dir under the OS temp dir (path printed);
  an outDir argument still wins. The 14 PNGs under `docs/rotate-rings/` are
  removed - only the drive-check that wrote them named them.
- Checks: `ui:shell` section 10 (status classes and panel across three
  messages), `leave:tool` section 9 (each column menu shut by a double-click,
  nothing else moved). Both fail on the code before this change. `?v=`:
  `app-join.js`, `app-input-mode.js` shell1 -> uiclean1; `styles.css` shell4 ->
  uiclean1 (a comment that described the old class wipe).
