## Draw: Line assist - rough strokes made straight walls, true arcs, or left smooth (2026-11-16)

`NSO_Sketch.assist(pts, { mode: 'straight' | 'auto', closed, dirs })` in `nso_sketch.js`: corners from the turn over a
window on a wobble-averaged copy; each run fitted as a line (snapped to 15 degrees or a traced wall's angle) or a circle;
straight ends of a corner-less bend (U, J) peeled first; Straight cuts a bend into lines. Two lines meet where their
lines cross. `app-draw-editor.js`: a Line assist switch (Off / Straight / Auto, kept in localStorage) applied to every
pencil stroke on release, Shift on release = Straight once, and Clean up for strokes already drawn (Auto when Off).
The top bar wraps on narrow screens. Checks: `sketch:test` (rough L, rectangle, half circle, U, J, circle, traced
angle), `draw:assist` (real pencil strokes).
