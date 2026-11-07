## Wheel: the start - a standard ball that drops its own piece
`app-wheel.js` (`NSO_wheelThrow`, `NSO_wheelDrop`, `NSO_wheelSync`,
`NSO_wheelDefaultBall`), the Wheel menu's H / R boxes now optional, `index.html`
re-stamped. Write-up: `docs/POTTERY-WHEEL.md` "Direction" items 5 and 6.

**What was wrong.** On an empty plate Ball said "Set a target height first", and
with a height typed it said "Select a piece first" - the wheel only ever
replaced the mesh of a piece that was already selected, and wanted a finished
size before the clay had been touched. Worse, the second refusal left a
*phantom session*: Ball set `NSO_wheelSession` first and only then found there
was nothing to bake onto, so the next piece anyone selected could have the
wheel's form baked onto it by Open or Pull.

**What it is now.**
- **Ball needs nothing.** No height: the standard ball, 25 mm radius, 65.4 cm^3.
  Pressed flat it is a 167 mm plate that fits the A1 Mini; opened it is a bowl;
  anything bigger is built by adding clay. A typed H (with R) still sizes the ball
  from a finished vessel by Pappus, exactly as before.
- **Ball drops a piece of its own** ("Wheel 1", "Wheel 2"...), Stock's drop step
  for step: one `addModels` Undo entry, the nearest free spot to the middle,
  selected. A selected piece is no longer overwritten.
- **The session belongs to that piece.** `NSO_wheelHome` holds its id and the
  history of `{ piece, soup }` the wheel wrote. Every move acts on it whatever is
  selected, and selects it. Undo puts triangles back by reference, so an identity
  test on the soup is the whole check: after an Undo the session rewinds to the
  matching step; if another tool changed the piece the session ends ("Wheel stood
  down") and does not overwrite it; if the piece is gone it says so. A refused
  Ball starts no session.

Two things a later ticket should read before touching this:
- **There is no "add clay" move yet.** Several refusals say "add clay here" and
  the start now leans on it for anything bigger than the standard ball. Rim + adds
  clay but only on a straight wall, which the buttons cannot make (docs "Direction"
  item 4 / the loop profile); the lever that adds clay to a solid, a disc or a
  bowl is the next thing the standard ball needs.
- **`app-wheel.js` still has two selection notions to respect:** the selected slot
  (`state.selectedIndex`) and the edit target (`state.editId`, what
  `getActiveModel` reads). `NSO_wheelSelect` checks both; a test helper that sets
  only `editId` (`selectModel`) is how the second one was found.

`npm run wheel` (135 checks, was 120) and `npm run wire:wheel`, which has a new
section 1b: an empty plate, nothing typed, nothing selected; a refused ball; the
standard ball; a plate that fits the A1 Mini; Undo rewinding the wheel; a second
ball being a second piece; a move acting on the wheel's piece with another
selected; a piece changed by something else; a piece gone.

Test change worth knowing: `tools/nso_wire_stock_test.js` section 5 pinned "Ball
still bakes onto the SELECTED piece, the way it always has". That is the behaviour
this ticket removes on purpose, so the check now says the opposite - Ball drops a
piece of its own and leaves the selected one untouched. (`nso_shell_v3_test`'s
"CLEAR PLATE ... keeps the loaded pieces" fails on the tree before this change
too; it is not this ticket's.)
