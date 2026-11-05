## Soften: Pick edges, and R up to 15 (2026-11-05)

New: `nso_box_edges.js` (kernel), `tools/nso_box_edges_test.js` (`boxedges:test`), `tools/nso_soften_edges_drive_check.js` (`soften:edges`, a drive),
`docs/SOFTEN-EDGES.md`. Changed: `app-finish.js` (`softenCompute` takes `edgePick` + `edges`; `edgeRoundStatus`), `app-soften-live.js` (the Pick edges
state, edge drawing, click-to-nearest-edge), `index.html` (R and slider max 15; the Pick edges row; the kernel's script tag).

**Why.** Recreating the Anti-Wobble Desk Spacer body (30 x 30 x 50, two long edges at R 15 = a half-round, two at R 3) was impossible: the R field
stopped at 5, and Soften rounds all edges of a face or all twelve. **What you get:** tick Pick edges, click edges, set R, Soften; a second bake adds to
the first at its own radius; one Undo step per run.

**Design choice worth a look.** The wrap generator (`rawWrapSolid`) is per-face: an edge rounds when both faces do, with balls at corners, so it can
not express "two edges". Rather than add a per-edge case to it, the new kernel clips the box by each edge's profile planes. Cost: three picked edges
at a corner mitre instead of forming a ball. Both paths stay; the wrap is untouched and used whenever Pick edges is off.

**Left as is.** The wrap's own clamp (`0.45 x` the shortest side) still applies with Pick edges off, so a 30 mm box takes at most R 13.5 there; R 15 is for
picked edges (`fitRadii`: up to the whole width, half for a pair). The per-face engines clamp to their wall limits as before. `app.js` is dead code
(see ARCHITECTURE_AUDIT.md) and was not touched. Edge picking is plain boxes only; corners styles refuse with a reason.
