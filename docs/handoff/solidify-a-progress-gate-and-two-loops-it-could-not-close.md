## Solidify - a progress gate, and two loops it could not close (2026-09-24)

Found by driver-testing round 1 (single operation, three sources of truth:
`nso_damage.js`'s prediction, the Watch log, `mesh_validate.py` on the result).
All three agreed - and what they agreed on was a bug: on
`fixtures/damage/shape-cylinder_holes-light.stl` (`hole`, shape-cylinder,
severity light, seed 7; 16 open edges in 2 loops) Solidify said
**"Solidify ok - open 16→16"**, pushed a `solidifyReplace` Undo, and left the
piece byte-identical. The result gate only asked "is it worse?".

**Now** (`app-finish.js`, comment above `solidifyCensus` and above
`SOLIDIFY_LOOP_MAX_EDGES`):
- **Progress gate.** A result with as many open edges as the input is
  `Solidify refused - closed none of the N open edges ... - left open: <why>;
  piece unchanged`, nothing committed, no Undo. Fewer but not zero commits as
  `Solidify partial` and names what was left and why. `Solidify ok` means 0 open.
- **Pinched loop** (two cap-fan holes meeting at the centre vertex: one
  boundary component with a degree-4 vertex). `capSmallOpenLoops` walks the
  boundary undirected and skips any loop with a degree != 2 vertex.
  `solidifyDirectedLoops` walks directed half-edges and splits the figure
  eight into its two simple cycles.
- **Folded loop** (three top-cap faces plus the wall face under them: folds
  90° over the rim and reaches z = 0, on no plane). `capAllOuterHoles` only
  caps loops on a bounding-box plane. `solidifyFillLoop` triangulates from the
  loop's own vertices with Liepa's weight (worst dihedral first - against the
  surrounding faces too - then area), which puts the crease back on the rim.
  A flat best-fit-plane fill was tried first: checker-clean, but it chorded
  through the solid and lost 1.04% of the cylinder's volume. With the dihedral
  weight the result's volume equals the clean cylinder's to 1e-13.
- Loops over 64 edges (NSO_Repair's `MAX_HOLE_EDGES`), open chains, and fills
  that must fold past 150° are left open and named in the status.
- **Winding joins the result gate.** Found while checking the new `partial`
  path: on `shape-sphere_holes-shredded.stl` the coarse welds +
  `repairJoinedSoup` close 13 of 221 open edges and mis-wind 21 (0 → 21 by the
  canonical checker). Open went down, nothing the gate watched went up, so it
  would have committed as progress. `solidifyRegressions` now also refuses on
  `mis-wound a→b` (NSO_Repair.inspect `flippedEdges`).

`tools/nso_wire_solidify_test.js` sections 4 (this fixture: both failure modes
shown present, then closed, PASS, 0 piercing, clean volume, one Undo), 5 (a
tilted open tube with two 80-edge rims: refused, bit-identical, no Undo) and 6
(the shredded sphere: refused on winding, bit-identical, no Undo).

Not changed, and still the open "coarse-weld tradeoff": the 0.2 / 0.3 mm grid
welds run first. On `shape-sphere_hole-painted.stl` they still raise NM and
the result gate refuses, even though the loop closer alone would close it.
Same story on the shredded sphere: the loop closer run on the input directly
takes it 221 → 85 open with 0 mis-wound; behind the welds it gets 221 → 208
with 21 mis-wound. That is the evidence for the coarse-weld ticket, not a
change made here.

**Follow-up, minor, not fixed here:** a plain click that selects a piece
(no drag) writes **"Moved model #N"**. `endMoveDrag()` in `app-core.js`
correctly skips `pushUndo` when nothing moved, but still calls
`setStatus('Moved model #' + (idx + 1))` unconditionally. Seen in the Watch log
of driver-testing round 1. Low priority; the log is honest, the app's line is not.
