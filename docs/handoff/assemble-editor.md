## Assemble - Join, Seat and Align in one card, and an editor: click two faces, see a ghost, weld (2026-11-15)
The owner's ask (2026-11-15), with a real plate (two dust covers, two risers
to stand on their ends): merge the Join, Seat and Align cards into one
ASSEMBLE card; selecting, aligning, seating and joining was "a lot of jumping
between controls", and a vertical join could not be had at all. Chosen in the
session: the two-face click flow, in an isolated editor like a slicer's paint
mode, with a ghost preview before the bake. Full write-up:
[docs/ASSEMBLE-EDITOR.md](../ASSEMBLE-EDITOR.md).
- **The card.** `#menu-assemble` in the column. **Open editor** on top, then
  the three old cards as `.vp-sec` sections - Join by slots, Seat, Align -
  every control under its own id, behaving as before. Opening the column
  starts the Join session (`joinWireCard`), shutting it is Cancel, opening
  another menu leaves A and B standing.
- **Removed ids:** `menu-joins`, `menu-seat`, `menu-align` (Align leaves the
  top row). **New:** `menu-assemble`, `asm-card`, `btn-asm-open`,
  `asm-sec-join|seat|align`, and the editor's `asm-*`.
- **The editor** (`app-asm-editor.js`): its own canvas over the app, the
  plate's pieces spread in a row. Click the face to attach (or *Use its
  underside*), click where it goes - a ghost follows the pointer, mated,
  before the click. Then a 3 x 3 pad (edge / corner / centre, read as the
  view has it), nudge, quarter turn, gap; **Weld into one** or **Place**. One
  Undo. Nothing on the plate moves before that.
- **Reused, not rewritten.** The move is `NSO_poseApplyWorld`
  (`app-seat-surface.js`, Seat here's commit given a world matrix); the weld
  is `joinSelectedModels({ inPlace: true })` (kernel union where they stand,
  no fuse, no plate weld, result not parked at the midpoint); `NSO_recordSeat`;
  `stepGroup`. `joinSelectedModels` now resolves `true` on a join.
- **Status strings:** "Open JOIN, ..." reads "Open ASSEMBLE, ..." in
  `app-join.js`, `app-join-triple.js`, `app-center-lock.js`,
  `app-seat-surface.js` (two checks re-pinned).
- **Two behaviours beyond the letter of the ask, flagged for the owner:**
  Weld is disabled while an air gap is set (Place is the action), and a mate
  that would hang under the plate raises the piece it goes on by the deficit
  instead of refusing. Both say so. Say the word and either becomes a refusal.
- **Reported, not changed:** the Join card's Vertical + gap-off JOIN does not
  move B - Complete Join never reads the toggle, and on pieces of different
  heights its "seated port" branch bundles the two shells where they stand
  and reports `Join ok`. Pinned as-is by `join:triple` 13; the owner's call.
- **Known quirk met on the way:** Join's own Undo puts A back on the ingest
  baseline (y + 0.1); the next move re-settles it. Pre-existing; the editor
  settles the piece it mates onto before it commits, as Seat does.
- Checks: `npm run asm:editor` (new, `driveSteps`, weight 43000). Re-pinned
  to the card: `join:triple` 12 and 18, `shell:v3`, `ui:shell`,
  `topbar:accordion`, `leave:tool`, `lock:test`, `subtract:pick`,
  `connect:drive`, `skin:drive`, `watch:test`, `qa:tour`, `big:profile`.
