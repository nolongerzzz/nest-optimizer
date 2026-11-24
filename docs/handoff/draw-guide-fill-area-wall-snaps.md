## Draw: Guide lines, Fill area, Line tool snaps held to the walls, a tidy after the weld (2026-11-18)

The owner could not draw straight furring onto a bent sheet whose walls run 10 degrees off the grid, and crop-and-glue left
a seam that would not seal. `nso_sketch.js`: `regionAt` (grid flood of the space round a click, bounded by the trace,
drawn lines and guides; grown `bite` into the walls by a walk that cannot cross a guide or wrap its ends; the guide side
put on the guide, FLUSH_GAP past it); objects of kind `guide` are never built (`solids`, `bounds`, `describe`).
`app-draw-editor.js`: Guide process type, Fill area tool (B, *Fill area grows*), the Line tool's snaps (corner, meets
the edge, along / square to a traced wall, Shift 15 degrees, edge, grid) with a marker; the trace simplified (RDP 0.02)
for corners and directions. `app-draw-connect.js`: each weld / cut tidied by `NSO_Repair.commit` when it changes
something and keeps the volume. Checks: `sketch:test` (fill area), `draw:fill-area`.
