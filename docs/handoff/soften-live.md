## Soften, live - pick a style from four pictures, watch the ghost on the piece, slide R, press Soften to bake (2026-11-03)

New: `app-soften-live.js` (the card, in Thicken's shape: `app-thicken-live.js` is the model for it), `tools/nso_soften_live_drive_check.js`
(`soften:live`, a drive). `app-finish.js` splits `applySoftenOnFace` in two; `index.html` (Surface & edges: the Soften button now opens a panel, the
Round / Corners / Corners+edges / Bevel drop-down `sel-edge-treat` is gone), `styles.css` (a few rules), `app-stock.js` (its tile painter takes an optional
per-triangle tint, exported as `nsoStockShelf.paint`), `app-core.js` and `app-input-mode.js` (one condition and one branch each).

**The flow.** Select a piece, Surface & edges, **Soften**: a 2 x 2 shelf of tiles opens (nothing on the piece yet). A tile picks the style and the piece
turns to a ghost with what Soften would leave drawn over it (the whole result faint, the surface that changed bright green). The R slider (the R box above
the button is the same number; both are bound by `app-live-slider.js`) re-runs the engine on every move. **Soften again bakes it.** Cancel or Escape drops
it; so does another tool taking the hand (it clears `state.softenArmed`) and any change of selection or piece under it.

**The bake installs the soup that is on screen.** `applySoftenOnFace` used to compute and install in one breath. The compute half is now
`softenCompute(m, o, commit)` and everything that used to call `commitSoften` calls the `commit` it is handed (the two pocket wraps take it as a last
argument). `applySoftenOnFace` passes `commitSoften`, so a click-bake is what it was. The live card passes a function that keeps what it is handed, draws
it, and on Soften calls `commitSoften` with that same soup - so there is no second calculation that could disagree with the ghost, and every refusal
(paint, seal gate, "fights a face already softened") happens at preview time with its usual words.

**What needs a click.** Nothing, for a box (Full wrap on) or a piece with pockets the wrap can name: the whole piece previews when the style is picked.
Anything else - a cut end, a tube, a cylinder, or a box with Full wrap off - is softened a face at a time as before: the style waits ("click the face to
soften"), a click (on release, not a drag, so orbit and move still work) adds that face to the preview, a second click on it takes it off. The old
arm-then-click-bakes block in `app-core.js` stands down while the card is open (`window.nsoSoftenLive.on()`); it is still reachable by setting
`state.softenArmed` from outside the card (the Cap flow and the headless checks do), and `softenSelectedModel` falls back to it when the card's script is
not loaded. The pocket wraps go through the boolean kernel, so their preview arrives a moment after the change; a change made while one runs waits for it
(`state.nsoWrapBusy`).

**The tiles are drawn from the engine**, like Stock's (no image in the repo): a 10 mm cube with its **top face** softened by `softenSelectedFace` in that
style, lit green wherever it is not one of the cube's own planes. One face and not the whole cube on purpose - see the next paragraph.

**Round and Corners+edges are the same shape on a whole box.** `rawWrapSolid` gives twelve quarter-round edges and eight ball corners for both
(identical triangle counts, 2508). They differ only on the face-at-a-time path, where Round rounds the face's rim and Corners+edges adds the setback
blend into the corner balls. So on a box with Full wrap on, picking Corners+edges previews exactly what Round does. That is the engine's behaviour,
unchanged here; it is why the tiles show one softened face (four different pictures) and not a wrapped cube (two identical ones). If the two should differ
on a box, that is a change to `rawWrapSolid`, not to this card.

**Tests.** `soften:live` is new: the card, four distinct tiles that each light some surface, every style previewing on a box with no face clicked, R by box
and by slider, the bake equal to the ghost bit for bit with one Undo step, Cancel / Escape / another tool, a cylinder by real clicks (add, remove, bake),
Full wrap off, a click on a box that names nothing, and a pocket piece through the kernel. Changed: `nso_pick_release_test.js` (the Soften verb is now a tile,
the preview, and a second press; the pocket piece exercises the kernel preview), `nso_shell_v3_test.js` (`sel-edge-treat` is retired to `soften-shelf` the way
Stock's select went to `stock-shelf`, and the four styles are checked as tiles).

Things worth knowing:
- `sel-edge-treat` is gone from the page. `getEdgeTreat()` already fell back to `state.edgeTreat`, which the card now sets; anything that wrote the select
  should write that instead.
- A second Soften on a piece that already carries a run (`m.softenRun`) re-bakes from the run's base and does not push a second Undo step - one Undo goes
  back to before the first bake. That is the existing run behaviour, kept; the ghost is drawn against the piece as it is now.
- `nso_shell_v3_test.js` has one failure, `CLEAR PLATE takes every piece off the plate and keeps the loaded pieces`, that is on the branch without this change too.
- Not done: the ghost highlights the surface that is not on a plane the piece already had (a plane lookup, `planeIndex` in `app-soften-live.js`), so a
  mesh with many slightly different planes may light a little more than Soften changed; nothing bakes from it.
