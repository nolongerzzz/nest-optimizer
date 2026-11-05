## Stock live editing - the card adjusts its piece, the wheel's pattern (2026-09-19)
`app-stock.js`, `npm run stock:live` (`tools/nso_stock_live_test.js`), in
`npm test`. Full write-up: the "Live editing" section of `docs/STOCK.md`.

**What it was.** New stock ADDS. Pressing it again with a different waste
margin left TWO blocks - two models, two meshes, the second 31.96 mm to the
side - with the positioning, the pose and the selection all still on the
first. Changing a card field on its own did nothing at all. (Worth recording
because the ticket described it as "regenerates on every card adjustment": the
mechanism was the other way round - no field did anything, and only the button
spawned - but the experience was the one described.)

**What it is.** The button opens a SESSION on the piece it made and every
control then edits that piece in place, through `NSO_sculptCommitRaw` - the
Pottery Wheel's pattern, called out as such: `NSO_wheelSession` holds a
profile and bakes each move onto the same model; `session` here holds the
model id and a fingerprint of the soup this file last wrote.

Three things a later ticket should read before touching this:
- **"The same object" means the same PIECE, not the same Mesh.**
  `NSO_sculptCommitRaw` disposes and rebuilds the `THREE.Mesh` - for Stock
  exactly as for Smooth, Extend, Fatten, Hollow and the wheel. Asserted as
  CHANGING in the drive check, so nobody later reads a gate that claims
  otherwise. What is asserted stable: model id and list index, placed entry
  and index, x / z, `rotY` / `tipX` / `tiltX` / `flipX`, and the selection.
- **The session ends rather than overwriting.** A fingerprint (triangle count
  + coordinate sum) of the last soup this file wrote is checked before every
  update, so New stock -> Hollow -> nudge a field does NOT discard the hollow;
  the session ends and says the work is kept. Same for another piece being
  selected, the piece being deleted, and paint. An unprintable size is
  refused with the block unchanged and the session LEFT LIVE, so the next
  valid value still works. One negative control each.
- **One undo entry per session, not one per keystroke,** done locally in
  `app-stock.js` by dropping the entry `NSO_sculptCommitRaw` just pushed once
  the session already has one. Measured: seven adjustments leave one
  `stockReplace`, with the person's own two `posePlaced` entries untouched
  under it. The wheel's live drag has the same problem and still pushes per
  frame; if a second tool wants this, move it into `pushUndo` as a coalesce
  flag and let both take it rather than growing a second copy here.

New stock now also SELECTS the piece it made, through `selectPlaced` rather
than by writing `editId` behind its back - it did not select anything before,
and the session needs it. `PAINT SCOPE` is now two rows: the create path is
`none` as it always was, the update path is `whole-piece`.
