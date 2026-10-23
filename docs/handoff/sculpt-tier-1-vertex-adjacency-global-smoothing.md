## Sculpt tier 1 — vertex adjacency + global smoothing (landed, `app-sculpt.js`)

Full write-up with numbers: `docs/SCULPT-TIER1.md`. Self-test:
`node tools/sculpt_selftest.js`. Script tag added to `index.html` at the
existing `?v=inside3` — tag NOT bumped.

State: both tiers built and measured. Topology invariance verified on every
fixture (same vertex count, triangle count, connectivity; only positions
move). Global Laplacian has no feature preservation and no way to protect a
region — that is the brush tier, and nothing in `app-sculpt.js` should grow
a feature term.

Three findings land on code this ticket did NOT touch. They matter for the
merge-order pass because each is someone else's gate:

1. ~~`NSO_weldEpsFor` (app-join.js) caps the weld tolerance at the strict
   minimum edge~~ — FIXED in weld-eps1. It now rejects the bottom 0.1% of
   edges that sit >=4x below the next edge up, so the tape's 2 slivers no
   longer pin the mesh: 4.997e-6 -> 4.2397e-5, and the part reads 0 open
   instead of 1402 (NSO_buildAdjacency) / 4 (NSO_edgeStats). All five call
   sites (2 in NSO_unionSoups, 2 in subtractSoupBFromA, 1 in
   joinSelectedModels) inherit it. 50 of 51 repo fixtures are bit-identical.
   `NSO_sculptWeldTol` stays for now — see docs/SCULPT-TIER1.md.
2. `NSO_edgeStats` and `rawCheckWatertightQuick` weld by coordinate
   rounding, so neither can see a backwards-wound face: it pairs every edge
   and reads 0 open while the volume is wrong. `NSO_buildAdjacency` counts
   directed edges (`stackedDirs`) and requires 0 for watertight. This is a
   second, distinct hole alongside the already-parked 208-odd-edge tolerance.
3. `tools/stl_watertight_check.py` rounds to 1e-5, too tight for a float32
   STL of an 82mm part: it reports 1406 false open edges on the tape fixture.

None of the three touched — each wants its own scoped pass and an APPLY.
