# Move: the plate drag is flat

`app-core.js` (`startMoveDrag`, `dragMovePlaced`, `endMoveDrag`). Checked by
`grab:drop` (`tools/nso_grab_drop_drive_check.js`, sections 9 and 10).

Press on a piece and drag: it moves in **X and Z and nothing else**. This is
Move, and it is also what any tool that moves a piece on the plate without
naming a surface does (it is the same drag).

- **Height never changes during the drag.** The piece is held by the point
  under the pointer on the plane it was grabbed on (the bed for a piece on it;
  its own bottom for a piece in the air - `liftY` is kept, floating is still a
  state, `docs/GRAB-DROP.md` section 2).
- **Nothing is read under the pointer.** No ray, no box, no vertex on a pointer
  move: the move is `pointer -> plane -> grid snap -> mesh.position.x/z`.
- **Overlap is allowed** (work as is). A piece may pass over and through another
  and be let go there. Nothing checks geometry on Move.
- **The release settles the height once**: the piece's lowest point on the plate
  (`settlePlacedOnBed`, a piece's lowest point being its lowest vertex as posed,
  `nso-bounds.js`, #220), computed once from the pose bounds the piece already
  has. A translation never invalidates them, so a piece that has not turned is
  not re-scanned. A floating piece stays floating: the lowest point is
  `0.2 + liftY`.
- **Escape** mid-drag puts the piece back where it was picked up. No Undo.
- **One Undo** per drag that moved the piece (`movePlaced`: x, z and the mesh's
  height as it was). A press that does not move is a click.
- The plate grid's **Snap to grid** still applies. The red neighbour fence lines
  are drawn as before (section "Not changed" below).

## What the drag no longer does

#190 made "rest on whatever is under the pointer" part of every plate drag
(`app-grab-drop.js`). It was meant as Lift's own gesture (#189) and is that
again: **Lift's drop** (`docs/GRAB-DROP.md`) is carried only by a piece Lift
left in the air. On the plate, as part of a plain drag, it climbed other
pieces and the bed's edge mid-drag, jumped pieces when they were let go, and
cost a scene raycast per pointer move.

The jobs it did on the plate, and where they live now:

| it did | now |
|---|---|
| stack a piece on another (let go over a piece) | **Seat** (Seat here / Seat) |
| butt two pieces together | **Join** (and Align edges, Center lock) |
| attach a piece to another | **Connect** |
| bring a piece in the air down onto the plate (let go over the bed) | **To plate**; or, for a piece Lift left in the air, Lift's drop |
| leave a piece in the air where it was let go | Vertical placement (arrows, slider); a flat drag keeps whatever height the piece has |

## Not changed

Move's nudge arrows, the vertical slider and arrows, Rotate, Tip, Tilt; the
position lock (a locked piece does not start a drag); the Join session's flush
readout after a drag (`reportJoinFlushGap`, once, on release - it was also run on
every pointer move; that per-move run is gone, nothing checks geometry on a
move); the red fence lines drawn round the other pieces' footprints while a
piece is dragged (a plain outline, not a geometry check).

## Measured

`tools/nso_move_flat_bench.js` (not a gate): ms of the app's JS per pointer move
and from pointerup to at-rest, box_closed and a 1,000,000-triangle stand-in for
the vase. The tables are in the PR that made the drag flat.
