## Draw: the Line tool follows edges; Fill area closes small gaps (2026-11-18)

The owner hand-drew guides along a traced fillet and their own beads and got gaps and sliver triangles. Now the
boundary is used instead of redrawn: `app-draw-editor.js` `followPath` joins two points on the same edge (traced
outline or anything drawn) along it, the shorter way round a closed one (Alt: the chord); edge snapping includes
drawn objects. `nso_sketch.js` `regionAt` takes `gap`: boundaries thickened by half of it, the flood let back out by
the same half (never past a guide), so a line stopping a hair short of a wall still closes a space; the editor's
*closes gaps to* (0.5 mm). Check: `draw:follow`.
