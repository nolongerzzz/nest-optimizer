## Draw: Bead side - the path drawn is the bead's edge, laid off the wall; wall-corner snaps (2026-11-18)

The owner could not place a bead: it straddled the cross-hairs. `nso_sketch.js`: `align` 'left' / 'right' on a line
(`edgeOutline`: the path is one edge exactly, the other the path moved the whole width over, mitred; `bite` reaches back
over the path into the wall so a weld bites instead of only touching - it refused before); `side()` takes a miter
option. `app-draw-editor.js`: Bead side (Centre / Left / Right / Off wall, kept in this browser; Off wall = away from the
traced piece, per stroke), Flip, beads drawn as they will be built and live while drawing, and the Line tool's
wall-corner snap (where two walls meeting through a fillet would cross). Checks: `sketch:test` (bead side),
`draw:bead-side`. Tried on the owner's thicken_oneside: an L along the channel's inner faces, welded clean.
