## Wheel: the white edge stays on while the sliders move
`app-wheel.js` ("7h. THE WHITE EDGE": `NSO_wheelGuideLines`, `NSO_wheelWear`,
`NSO_wheelOutline`), `app-wheel-live.js` (the preview redraws it), `app-sel-outline.js`
(a small optional hook). Write-up: `docs/POTTERY-WHEEL.md` "The white edge".

**What was wrong.** The selected piece's white edge came and went as the sliders moved.
Two causes: (1) the edge is a child of the mesh, and every slider release rebuilt the
mesh through the sculpt commit, which never redraws it - so it went off until the piece
was selected again; while dragging, the preview swapped the geometry and left the old
shape's edge hanging. (2) The house edge is "a crease sharper than 15 degrees", and a
smooth piece (ball, pressed disc, rounded bowl) has none at all - so it was only ever on
for a creased shape.

**What it is now.** The preview, the commit, Escape and Undo each leave exactly one white
edge, on the geometry you are looking at (tested across every slider, during the drag and
after the release). For a smooth piece the edge is drawn from the piece's own profile:
rings at creases and wall ends, a few evenly spaced ones on the smooth stretches, eight
meridians. The hook is `g.userData.nsoEdges(g)` in `app-sel-outline.js`'s `buildHere`
(and `useWorker` skips such a geometry); a function on `userData` is copied by reference
when a geometry is cloned, so the geometry Undo restores keeps it.

Things a later ticket should read before touching this:
- **`buildHere` has no helper functions on purpose.** `tools/nso_undo_dispose_test.js` lifts
  that function out of the file by name; a new top-level helper it calls is not lifted and
  the test dies with a ReferenceError. Keep the hook inline.
- **The helper lines are see-through** (the house outline has depthTest off), so on an opened
  piece the inside rings show through the outside. If that is too busy, `NSO_WHEEL_GUIDE_SMOOTH`
  and `_MERIDIANS` are the dials.
- **Touching a slider selects the wheel's piece** (`NSO_wheelSelect` in the preview), because the
  selected piece is the one that wears the edge.
- The frame is the display geometry's bounding box: x, z centred, y up from the bottom.

`npm run wheel` (205 checks, was 197; section 7f) and `npm run wire:wheel` (section 10c: one edge
on the right geometry on a fresh ball, during every drag, after every release on six different
sliders, after Escape and Undo, and when another piece was selected).
