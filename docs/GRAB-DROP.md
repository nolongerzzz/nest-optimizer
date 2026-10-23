# Grab and drop, and the floating state

`app-grab-drop.js` (`window.nsoGrab`), riding on `app-core.js`'s move drag;
the seat is `app-seat-surface.js`'s (`NSO_seatPieceAt`). Checked by
`grab:drop` (`tools/nso_grab_drop_drive_check.js`, 1280 x 800).

**This is Lift's drop and nothing else's.** It was meant as #189's gesture -
grab the piece Lift left in the air, drop it on the plate - and #190 made it
part of every plate drag, where it climbed other pieces and the bed edge
mid-drag, jumped pieces when they were released, and cost a scene raycast per
pointer move. A plate drag is flat again (`docs/MOVE.md`); the grab is carried
only by a piece **Lift** left in the air: `NSO_LIFT_PLATE.ownsDrop(piece)`, true
while that piece is in the air (`liftY > 0`). app-core's `startMoveDrag` asks it
at the press; no other press begins a grab. A lifted piece that has come down
onto the bed is an ordinary piece (Move is flat); raise it again and it is
Lift's again. (G-scope's second plate carries its pieces with this same code;
that is its own gesture and is unchanged.)

What the grab used to do on the plate, and where each job lives now: **stack a
piece on another** -> Seat; **butt two pieces** -> Join; **attach** -> Connect.

## 1. Grab and drop

Press on a piece Lift left in the air and drag: it follows the pointer over the scene, the piece
itself looked through. Where it is let go decides where it lands:

| let go over | it lands |
|---|---|
| **a piece** | seated onto that surface at the point under the pointer, outside it, at the **Seat gap** (Join's slider, default -0.18 mm). This is Seat here's own seat - `NSO_seatPieceAt`, the same `NSO_SeatSurface.plan`, the same gap rule, the same refusals, the same paint scope. The piece a lifted feature came off is a piece like any other. |
| **the plate** | on the plate at that point (To plate): the piece comes down onto the bed as it is carried (app-core's move drag with the grid snap). |
| **nothing** | where it was let go, in the air. It is still grabbable. |

While it is carried it shows where it is going: over a piece it rests off the
surface along the normal there (the real seat is worked out on release, on
the real surfaces) and the piece is boxed green with the drop point marked;
over the plate it slides on the bed; over nothing it follows the pointer on a
plane square to the view through the point it was grabbed by. The status
line says what letting go will do.

- **Escape** mid-drag puts it back exactly where it was picked up. Nothing
  goes on the Undo stack.
- **Each drop is one Undo.** Into the air, or down onto the plate from the
  air: the whole pose it was picked up in (`posePlaced`). A plain drag
  of a piece on the plate is not this: `movePlaced`, `docs/MOVE.md`. Onto a piece: the seat's own step
  - a `posePlaced`, or `dropSeatReplace` (the soup and that pose together)
  when the seat has to turn the piece.
- **A drop places; it never fuses.** Join stays the deliberate step.
- **A click is still a click.** A press becomes a carry once the pointer has
  travelled 3 px (`nsoGrab.SLOP`); before that nothing moves. Without it a
  press on a floating piece would drop it on whatever is behind it.
- Escape mid-carry puts it back (a flat Move drag has its own, `docs/MOVE.md`).
- Move's nudges, the vertical slider and arrows are unchanged. Vertical
  placement still refuses a drag, and a position-locked piece is not grabbed.

Refused in words, the piece put back where it was, nothing on the Undo stack:

- **onto a support piece** (`m.nsoSupport`): `"<host>" is a support piece -
  nothing is dropped onto a support.` - said while it is carried (the box is
  red) and again on release.
- **onto itself**: the pointer never offers it (the carried piece is looked
  through), and `NSO_seatPieceAt(p, point, p)` refuses it by name.
- everything Seat here refuses (below the plate, a painted piece that would
  have to turn, no surface under the mating face...), in Seat here's words
  with the pieces named.

The helper a carry draws (the green or red box on the target and the dot on the
drop point) is a registered helper (`nsoHelpers`, owner `grab-drop`) and is
taken out of the scene - not just emptied - when the drag ends: a drop onto a
piece, into the air or onto the plate, Escape, or leave-tool. Watch reports
nothing after any of them (`watch:test` section H).

## 2. Floating is a state

A piece in the air carries how far up it is as **liftY**, the record every
exporter already writes (`buildCombinedGeometry`, the 3MF build and its
scene block). The one rule: the piece's lowest point is **0.2 + liftY** -
what `settlePlacedOnBed` reads. Everything that moves a piece keeps it:

- Move's nudges (`applyPlacedXZ` -> `settlePlacedOnBed`), the vertical slider
  and arrows, Rotate and Tip (`applyMeshRotation`), Seat here (it seats the
  moving piece at the height the seat needs and settles the target with its
  own liftY);
- an Undo of a removed piece (it used to come back on the bed whatever its
  liftY said - fixed here).

The piece's lowest point is its lowest VERTEX as posed (`nso-bounds.js`), also
after a seat has baked a turn into its axes - see `docs/HANDOFF.md`, "A piece's
bounds after a bake".

Nothing brings a floating piece down except **To plate** or a drop onto the
plate. Export writes it at its height, like any piece.

## 3. Lift lands in place

A lifted feature now stays exactly where it was lifted (`app-lift-plate.js`,
`landInPlace`): the parent's pose, and the mesh where the parent drew those
same raw triangles. A feature on top of a slab is left resting on the
leftover slab, in the air over the bed - floating, until it is grabbed or
sent To plate. It used to go onto free plate beside the parent
(`nsoFreeSpot`, still Picture's). Pick, Shift-click and Strip are otherwise
unchanged.

## 4. Paint scope

None of its own. A drop over the plate or into the air is a move. A drop onto
a piece is `NSO_seatPieceAt`, whose scope is Seat here's - whole-piece on the
carried piece, and only when the seat has to turn it
(`docs/SEAT-SURFACE.md` §3).

## 5. In the real app (`grab:drop`)

The hinge plate (`tools/nso_lift_plate_fixtures.js`'s `hinge()`: a 64 x 40
slab, paper at 3 mm, two hinge halves - a leaf and two knuckles each). Lift
half A and half B: the box the plate drew each in, 3 mm over the plate's
bottom, liftY saying so; they stay there. **Lift's drop:** half A carried
over the parent's top: "Over "hinge-plate" - let go to seat ... at the Seat
gap (-0.18 mm)", boxed green; let go: seated, clearance 0.180 mm measured on
the surfaces, over the point it was let go at, still two pieces, one Undo;
Ctrl+Z: back in the air where it was lifted. Half B carried over nothing: let
go, position unchanged, floating, one Undo; the 3MF build writes its lowest Z
at liftY; still grabbable; a press without a carry moves nothing. Escape
mid-carry: back exactly, no Undo. Move nudge and Rotate 90 on the floating
piece: bottom unchanged. A support piece: refused while carried and on
release. Onto itself: refused. To plate: down. Half A, seated on the parent,
carried onto the bed: "Set down on the plate, from N mm up", bottom on 0.2,
one Undo; Ctrl+Z puts it back on the parent and it is still Lift's.
**Flat Move:** half A, now an ordinary piece, dragged across the parent: no
grab live, no helper in the scene, its height identical at every move, no ray
on any pointer move or on the release; let go over the parent it lands there,
overlapping, its bottom on 0.2 (it did not climb), one Undo. A small piece
turned off-axis and raised 5 mm (not Lift's): the same flat drag keeps its
height, Escape puts it back, and from the press to the release none of its
vertices is read.
