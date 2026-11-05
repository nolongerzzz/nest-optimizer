## library/CTH_fixture.stl is the drive's INPUT, not its output
It was, for a while, its output. The file carried 1372 triangles, 94% of them
not axis-aligned - a box hull that had already been wrapped. `?cth=drive`
could not run on it: `nsoWrapAllReady` needs `rawBoxPockets() > 0`, a wrapped
piece is no longer a box pocket brick, so the Soften press ARMED instead of
baking and the drive reported `DRIVE FAIL (armed)`. Proof it was the drive's
own output: running the drive on `box_hull_80x40x20-2.stl` emits
"(1372 tris, one bake from source)" - the same 1372.

It is now a copy of `box_hull_80x40x20-2.stl`: 28 triangles, same
80x40x20 bbox, one pocket, a clean brick. Do not save a baked result over it
again. `npm run cth:drive` fails loudly if anyone does.
