## Interlock - keys and sockets on the assembly editor: tongue, pin, snap tab; dragged or typed into place (2026-11-15)
The owner's ask (2026-11-15), building an X-axis lock for an A1 Mini: a tool
on the Assemble card to make interlocks and pins between two pieces like the
ones in their model, placed by dragging and by caliper input, also for fitting
prints to physical items. Chosen in the session: mate first then interlock;
tongue, pin and snap tab. Full write-up: [docs/INTERLOCK.md](../INTERLOCK.md).
- **Where.** `#btn-asm-interlock` (Interlocks & pins) on the Assemble card
  opens the editor on a new **Interlock** tab. The editor panel has tabs now:
  Mate | Interlock.
- **Flow.** Click a face. If a piece is seated on it (Place it there on the
  Mate tab), it is found, drawn see-through, and gets the socket; else the key
  or socket is made alone. Make: Key here / Socket here. Shape + caliper
  fields (Length, Width / Diameter, Height, Ease, Catch, Fit per side, socket
  goes through). Drag the key on the face (snaps to centre / flush / 0.1 mm)
  or type a, b, c, d - the distances to the face's four edges, exact. Turn in
  degrees. Apply = one Undo; neither piece moves.
- **Defaults** are the owner's model's: tongue 25 x 5 x 2, fit 0.10 a side.
- **Files.** `nso_interlock.js` (the solids, headless), `app-asm-interlock.js`
  (the tab). `app-asm-editor.js` gained modes: `NSO_AsmEditor.mode(name, def)`
  returns the kit; a mode gets clicks, hovers, Escape, first refusal on
  presses, `apart` for un-clustered pieces. `NSO_AsmEditor.open(mode)`; any
  element with `data-asm-mode` opens the editor on that mode.
- **Reused.** `NSO_unionSoups` / `NSO_subtractSoups` in the piece's raw frame
  via `nsoRawFrameOf` + `nsoRawPointFromLocal` / `nsoLocalPointFromRaw`,
  `NSO_sculptCommitRaw`, `nsoOverlap.solid`, `stepGroup`. New undo type
  `interlockReplace` in `UNDO_REPLACE_LABEL`.
- **A trap met and handled:** `NSO_sculptCommitRaw` re-centres on the new box,
  so adding a key to one side shifts the body by half the key. The result's
  world box is taken before the commit and x / z / liftY re-fitted after, in
  the same entry's `prevPose`.
- **Refusals, all in words, nothing changed:** result open; key shares no
  volume with its piece; socket removes nothing; painted piece; snap shorter
  than `ease + 2 catch + 0.6`.
- **Not done:** curved faces, dovetail, socket lead-in, a one-way latch; the
  a-d labels can overlap when distances are small.
- Checks: `npm run interlock:test` (node, in `testSteps`), `npm run
  asm:interlock` (drive, in `driveSteps`, weight 60000).
