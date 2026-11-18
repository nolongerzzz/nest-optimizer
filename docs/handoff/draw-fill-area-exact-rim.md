## Draw: Fill area's edge exact (no staircase, sharp corners), bounded by beads as built, bite default 0.1 (2026-11-18)

`nso_sketch.js` `regionAt`: the grid outline is densified and every point put back exactly - on a guide (0.02 past), or
exactly `bite` from the nearest boundary on the wall's side; where two touching / crossing boundaries meet, the crossing
of their moved lines (sharp corner); `cleanRing` takes out spikes, `fillable` test-triangulates, and a ring that would not
take falls back to the grid outline. `app-draw-editor.js`: lines bound a Fill area by their built outline; Fill area grows
defaults to 0.1 (measured on the owner's piece: 0 refused - two solids only sharing a face - 0.05 / 0.1 / 0.3 clean).
`app-draw-connect.js`: the "do not touch" refusal says to raise the bite. Gates in `sketch:test`; the Draw drives follow.
