## Tube edge Reducer: Keep length - reduce or expand the rim without making the tube longer (2026-11-04)

Changed: `nso_tube_edge.js` (section 8: `NSO_tubeEdgeKeepLength`, `NSO_teKeepScan`, `NSO_teKeepTrim`; a one-line hook in `NSO_tubeEdgeReducer`), `app-tube-edge.js`,
`index.html` (the `#chk-te-keep` flag on the Reducer card), `styles.css` (`.vp-flag-tekeep`), `docs/TUBE-EDGE.md`, `tools/nso_tube_edge_test.js` (section 12),
`tools/nso_tube_edge_drive_check.js` (section 9b).

**What you get.** Tube edge > Reducer > tick **Keep length**. The transition and the run are cut into the tube's own wall: the end ring takes the new Ø, the run goes down
from it, the transition eases back to the tube's Ø, and the piece stays exactly as tall as it was. Un-ticked, nothing changes (byte-identical, the pinned Flare / Roll
hashes hold).

**How.** It is the existing Reducer, not a second construction: take the last Transition + Run mm off the wall at a plane square to the axis, cap the cut, run the
Reducer on the cap, then hold the result to the ORIGINAL piece (topology, volume against Pappus, the end plane). Needs a straight wall at least Transition + Run + one
nozzle width long below the end; otherwise it refuses with the numbers and the longest Transition + Run that would fit.

**Worth knowing.** The cap's lean is pinned to 0 after the straight-wall scan: the cut's float noise (1e-8 rad) otherwise makes the Reducer lay a station 3e-8 mm above
the ring, a sliver, non-manifold. The Reducer's four rings are handles with Keep length too (`NSO_teReducerGeom().keep`): OD / ID on the end ring, R a Run down the tube (always drawn - drag it down to make a run), T a Transition below that; dragging down the tube lengthens (`NSO_teLenSign`), Shift + T is the plain Reducer's only. Not for Flare, or a leaning / tapered /
flanged stretch inside the cut.

Tests: `npm run tube:edges` (367 checks; section 12 is this), `node tools/nso_tube_edge_drive_check.js` (section 9b: the rings dragged for real), `tube:neck` unchanged. Neither `tube:neck` nor `nso_ring_test` changed.
