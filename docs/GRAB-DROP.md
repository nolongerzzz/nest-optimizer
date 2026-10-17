# Grab and drop, and the floating state

`app-grab-drop.js` (`window.nsoGrab`), riding on `app-core.js`'s move drag;
the seat is `app-seat-surface.js`'s (`NSO_seatPieceAt`). Checked by
`grab:drop` (`tools/nso_grab_drop_drive_check.js`, 1280 x 800).

## 1. Grab and drop

Press on any piece and drag: it follows the pointer over the scene, the piece
itself looked through. Where it is let go decides where it lands:

| let go over | it lands |
|---|---|
| **a piece** | seated onto that surface at the point under the pointer, outside it, at the **Seat gap** (Join's slider, default -0.18 mm). This is Seat here's own seat - `NSO_seatPieceAt`, the same `NSO_SeatSurface.plan`, the same gap rule, the same refusals, the same paint scope. The piece a lifted feature came off is a piece like any other. |
| **the plate** | on the plate at that point (To plate). This half is app-core's move drag as it always was: grid snap, the neighbour magnet, the fence lines, the Join flush-gap report. |
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
  air: the whole pose it was picked up in (`posePlaced`). Across the plate
  from the plate: `movePlaced`, as before. Onto a piece: the seat's own step
  - a `posePlaced`, or `dropSeatReplace` (the soup and that pose together)
  when the seat has to turn the piece.
- **A drop places; it never fuses.** Join stays the deliberate step.
- **A click is still a click.** A press becomes a carry once the pointer has
  travelled 3 px (`nsoGrab.SLOP`); before that nothing moves. Without it a
  press on a floating piece would drop it on whatever is behind it.
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

## 5. In the real app (`grab:drop`, 34 gates)

The hinge plate (`tools/nso_lift_plate_fixtures.js`'s `hinge()`: a 64 x 40
slab, paper at 3 mm, two hinge halves - a leaf and two knuckles each). Lift
half A: the box the plate drew it in, 3 mm over the plate's bottom, liftY
saying so; it stays there. Carried over the parent's top: "Over
"hinge-plate" - let go to seat ... at the Seat gap (-0.18 mm)", boxed green;
let go: seated, clearance 0.180 mm measured on the surfaces, over the point it
was let go at, still two pieces, one Undo; Ctrl+Z: back in the air where it
was lifted. Half B onto the bed: liftY 0, bottom 0.2, one Undo. Carried over
nothing: let go, position unchanged, floating, one Undo; the 3MF build writes
its lowest Z at liftY; still grabbable; a press without a carry moves
nothing. Escape mid-drag: back exactly, no Undo. Move nudge and Rotate 90° on
the floating piece: bottom unchanged. To plate: down. A support piece:
refused while carried and on release. Onto itself: refused.
