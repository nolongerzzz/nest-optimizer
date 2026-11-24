## Draw: trace a piece, draw on its border, Connect where drawn, stretch handles (2026-11-16)

The owner wanted to fur out the wall of a bent sheet: draw a block against the wall from above, then stretch the ghost
into place. `app-draw-editor.js`: **Trace a piece** lays a piece's top-view outline (`NSO_Slicer.sliceMesh` of its plate
soup at a height) under the sheet in plate mm, with edge snap for line points, shape corners and pencil ends; the trace
is kept on the sketch (`sketch.trace`, `NSO_Sketch.normalize`). `app-draw-connect.js`: a traced drawing opens already
placed on the plate under that piece (a pseudo-face: the plate's plane at the piece's foot), following the piece if it
moved; **Stretch ↔ / ↕** fields and four drag handles (`NSO_Sketch.solids` `stretch`); **Piece height**, **Where
drawn**, **1:1**. A top flush with the piece's is stood 0.02 mm over it (`avoidTop`): flush left 2 non-manifold edges
on the owner's Thicken output, 0.02 under left 32, over was clean (docs/DRAW.md). New check `draw:trace`.
