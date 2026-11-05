## Weave - lasso a patch out along its own triangles, clone its surface as a fresh weave, reattach it rim to rim (2026-11-01)

Write-up: `docs/WEAVE.md`. New: `nso_cdt.js` (constrained Delaunay + `fill`: a polygon woven into an even mesh whose rim is the polygon's own
corners; Weave fills each hole of work with it), `nso_weave.js` (the engine), `app-weave.js` (the card; the left bar's **WEAVE**, between TEXT
and PAINT), `tools/nso_weave_fixture.js`, `tools/nso_weave_test.js` (`weave:test`), `tools/nso_weave_drive_check.js` (`weave:drive`).
`app-core.js` gains one undo label (`weaveReplace`); `index.html` the menu and three script tags (`npm run stamp` sets their `?v=`);
`styles.css` a few rules. The Text drive check and docs say TEXT now sits between SHAPE and WEAVE; the shell tests that list the column
(`nso_shell_v3_test`, `nso_topbar_accordion_test`, `nso_ui_shell_drive_check`, `nso_leave_tool_test`, `nso_big_mesh_profile`) list `menu-weave` too.

Second version (the first is in git history: "Weave: cut a patch out along its own triangles"): the owner asked for the lasso only (Circle is
gone) and for it to work on curved / grooved surfaces like the palm - "draws on like a flat, but copies like a cylinder". The first engine laid the
whole patch as one height field along its mean normal and refused a 12 mm circle on the palm. Now:
- **The lasso is a cylinder along the view**: front-facing triangles whose centres project inside the loop, joined to the one under its middle;
  `close()` fills the islands (the engraving's back walls); Shift adds, Alt takes away (and keeps the hole: `close` opts.keep).
- **Work is found on the mesh by its creases** (35 degrees between neighbouring normals), no direction needed. Each hole of work is filled locally
  (height field along the face round the hole, thin-plate spline through 2.5 mm of face, rim correction), then the **cleaned patch is remeshed on
  its own surface** (isotropic remeshing, projection back onto the cleaned patch, rim held). No flatness limit.
- **Work the lasso's edge crosses is kept**, not refused: it is a feature (a palm crease, a letter half inside); the readout counts them.

Things worth knowing:
- *Dead ends, so nobody walks them again.* (1) One height field for the patch: refuses curls. (2) Unrolling the patch with LSCM and weaving in
  the plane (CDT lattice, lifted back by barycentric lookup): lovely on mild patches, but on the palm with the finger webs the flattened outline
  overlaps itself with no triangle turned over, and conjugate gradients took 30-60 s. (3) A quadratic moving-least-squares fill of a hole: 0.3 mm
  off where a letter lies in a groove; the thin-plate spline halves it.
- *The fixture's engraving is only about 41 degrees at its leanest* (a wall is one jittered triangle). At a 50 degree crease threshold the floor
  leaked into the face; 35 is why. A real scan's text walls are vertical. Walls gentler than about 35 degrees are a dish, not work.
- *close() and the underside*: an island that faces away from the cut is the rest of a closed piece, not a hole - but only islands over 2% of the
  cut and a few dozen triangles are asked (the hand's text has dozens of single-triangle fins past vertical).
- *Chords.* A fill, a flip or a collapse that makes an edge between two rim corners the mesh already joins (inside the patch for a fill, outside
  it for the remesh: `opts.blocked`) leaves three triangles on one edge. Found by the checker on the 12 mm palm.
- **X-ray after a bake.** `applyXrayView` / `applyXrayToMaterial` are nested inside a function in `app-join.js`, so `updateAdjustUI` never reaches
  them: every bake (Text, Brush, ...) drops X-ray on the new mesh until X is toggled, with the button still lit. Weave puts it back itself
  (`NSO_weaveKeepXray`). A one-line `window.applyXrayView = applyXrayView` would fix it for every tool - a behaviour change for all of them, so
  not made here (standing rule: ask first).
- `tools/nso_app_harness.js` looks for `chrome-linux/chrome`; this box has `chrome-linux64`. `PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`
  is the override the harness already reads.

PAINT SCOPE: WHOLE-PIECE - the same stand-down as Text (`nsoMaskCount(m) > 0`), before WEAVE and before REATTACH.

Numbers (the checker's: `NSO_Defects.locate`) are in `docs/WEAVE.md`. Not yet: a pitch that changes across the patch; keeping the plate as a piece
of its own; a drive step on the real hand (the file is the user's upload, 1.7 MB, not in the repo).
