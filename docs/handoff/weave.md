## Weave - cut a patch out along its own triangles, weave a fresh one in, reattach it rim to rim (2026-11-01)

Write-up: `docs/WEAVE.md`. New: `nso_cdt.js` (constrained Delaunay + `fill`: a polygon woven into an even mesh whose rim is
the polygon's own corners), `nso_weave.js` (the engine: welded mesh, selection, detach, height field, fit, weave, apply),
`app-weave.js` (the card; the left bar's **WEAVE**, between TEXT and PAINT), `tools/nso_weave_fixture.js`,
`tools/nso_weave_test.js` (`weave:test`, testSteps, 16 s), `tools/nso_weave_drive_check.js` (`weave:drive`, driveSteps).
`app-core.js` gains one undo label (`weaveReplace`); `index.html` the menu and three script tags (`npm run stamp` sets their
`?v=`); `styles.css` a few rules. The Text drive check and docs say TEXT now sits between SHAPE and WEAVE; the shell tests
that list the column (`nso_shell_v3_test`, `nso_topbar_accordion_test`, `nso_ui_shell_drive_check`, `nso_leave_tool_test`,
`nso_big_mesh_profile`) list `menu-weave` too.

What it is for: the clean way to take engraved text off `text_repair_test.3mf`. Crop a circle or a lasso on the surface (X-ray
shows the plate, its rim corners and the new weave), WEAVE, REATTACH. The plate is read as a height field; walls (over 55
degrees, and creases) cut it into pieces; the pieces that are not the face are the work; a quadratic fitted by moving least
squares to the face round each node carries the face across and Laplace spreads the last mismatch, so no step. The rim corners
are written back as the mesh's own coordinates, so the join is watertight with nothing to weld.

PAINT SCOPE: WHOLE-PIECE - the same stand-down as Text (`nsoMaskCount(m) > 0`), before WEAVE and before REATTACH.

Numbers (the checker's: `NSO_Defects.locate`):
- fixture (jittered slab, R30 cap, 0.6 mm engraving): new corners within 0.007 mm of the cap the engraving was cut from, rms
  0.001; volume 872.19 against the unengraved 872.30; open / non-manifold / odd / flipped / degenerate all 0, piercing unchanged.
- Against Text > Remove on the hand (`NSO_Resurface.scan`, 10 pieces of work): all ten at once is refused ("the outline could not be
  closed"), 9 of 10 apply singly with new-triangle edges p50 0.37-0.71 mm / p95 1.0-2.8 mm and angles p1 0.3-1.8 degrees; Weave's are
  p50 0.167 / p95 0.205 mm and p1 41 degrees, the whole word in one circle.
- the hand, a 7 mm circle on DUKE DOKS: 12,232 -> 12,116 triangles at 0.17 mm, angles p1 41 / p5 53 degrees, 1.3 s, closed as
  before, piercing 2544 -> 145. 8 mm is refused (the edge runs across a crease), 12 mm is refused (curls too far).

Things worth knowing:
- **The engine is a height field.** A cut that curls round (a circle of a palm's size, a finger) is refused in words; cut a
  smaller piece. Parametrised weaving of a wrapped patch is the way past it (not done).
- **The crop's edge must fall on clean face.** Otherwise the refusal says how many rim corners stand off the face, and they are
  drawn red; Grow, or cut wider.
- **Wall detection and the fixture.** An engraving cut by lowering vertices of a coarse mesh has walls only about 63 degrees; at the
  first version's 65 degrees whether a stroke was found depended on where the circle's centre fell (found by the drive check
  with a one-pixel-different click). Now 55 degrees, creases shut the gap, and the crease tolerance is 8 times the data's own
  roughness (a noisy scan raises it). Walls gentler than about 45 degrees are a dish, not work.
- **Small holes in a cut are closed** (islands up to half the cut, 5000 triangles): the walls and floor of an engraving are
  unreachable from the surface and would otherwise leave one. What the user cuts out with Alt stays a hole (`close` opts.keep).
- **X-ray after a bake.** `applyXrayView` / `applyXrayToMaterial` are nested inside a function in `app-join.js`, so
  `updateAdjustUI` never reaches them: every bake (Text, Brush, ...) drops X-ray on the new mesh until X is toggled, with the
  button still lit. Weave puts it back itself (`NSO_weaveKeepXray`). A one-line `window.applyXrayView = applyXrayView` would fix
  it for every tool - a behaviour change for all of them, so not made here (standing rule: ask first).
- `tools/nso_app_harness.js` looks for `chrome-linux/chrome`; this box has `chrome-linux64`. `PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`
  is the override the harness already reads.
- Not yet: a pitch that changes across the patch; keeping the plate as a piece of its own; a drive step on the real hand (the
  file is the user's upload, 1.7 MB, not in the repo).
