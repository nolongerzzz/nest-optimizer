## import-keep-positions - a Studio project lands where its file has it (2026-10-26)

**What the user saw.** `supp_ref.3mf` (six parts spread over the plate in Bambu Studio) came into NSO as a row along the
plate edge and had to be moved by hand, though the file carries the positions (Studio re-reads it intact).

**The change** (`import3MF`, app-core.js; the geometry-only route, UI/import only). With two or more objects and no usable
NSO scene block, `savedPlacements3MF(objects, plate)` takes each piece's footprint in the file (the reader already hands
back each object's transform applied, in Studio's plate frame) and returns plate-centred placements, the mapping
`buildPlacedObjects3MF` uses on export run backwards:

    x = Studio X - plate.w / 2        z = plate.d / 2 - Studio Y        (at the centre of the piece's XY box)

Each piece goes through the same `addModelFromZUpGeometryAsync` -> `placeNewModel` as before; `placeNewModel` takes the
spot from `options.at` instead of "beside the last". Pieces still rest on their lowest vertex (`placeModelMovable`
unchanged). If any piece's footprint is not entirely on the current plate (0.01 mm slack, so a piece touching the edge
fits), nothing is kept and the whole set goes in as before; the status says so: `... did not fit the plate at its saved
positions; arranged inside it`. Success adds ` - each at its position in the file`.

**Not touched.** The NSO scene route (`restoreSceneFrom3MF`); single-object files; library / Recent loads (they call
`handleFiles` / `import3MF` and so get the same behaviour for a multi-object file, nothing else); Optimize; Generate and
the supports code; control ids. A scene block that is declined at the confirm, or whose object count does not match,
still falls to the plain geometry import - with no change in where it places (the pieces beside the rest of the plate).

**Known edge.** Kept positions are not checked against pieces already on the plate: importing a second project, or the
same one twice, puts the new pieces on top of the old ones. (The old route offset new pieces beside the plate's right edge.)
The "arranged inside it" wording is the ticket's; the fallback is today's row, which for a set wider than the plate is
not itself guaranteed to fit.

**Fixture.** `fixtures/supports/supp_ref.3mf` (Studio 02.08.02.61, A1 mini, six parts). It was not in the tree.

**Check.** `npm run import:keep-positions` (`tools/nso_import_keep_positions_test.js`, a testStep, Node only: lifts the real
`import3MF` / placement / export functions into a vm with the real 3MF reader and writer):
1. supp_ref.3mf: six pieces at the file's XY (0.01 mm), resting on their lowest vertex
2. import, export, read the export: every piece's position equals the file's (and again with the scene block removed)
3. pieces that do not fit (the same file on a 100 mm plate; a box over the edge): old placement, status says so
4. an NSO-exported file and a single-object file load to the same plate as claude-wip at 7dc1d1f (hashes of the placed
   state; `NSO_CORE=<old app-core.js>` prints what an older core gives).

`?v=` stamped (`npm run stamp`): app-core.js. `index.html` otherwise untouched.
