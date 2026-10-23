## Face select - the target, next to the paint (2026-09-16)
`app-mask.js` (the second list and the second mode), `app-skin.js` (the one
consumer), `nso_skin.js` (`findFace` takes a plane), `index.html` / `styles.css`
(the Finish tab rows). Check: `npm run select:test`
(`tools/nso_face_select_test.js`, in `npm test`, 72 checks: 15 in Node on a
pocket block, the rest through the shipped controls in headless Chromium).

**Audit first (Task 1), what was found.**

- *Join's "Lock faces (optional)"* is a dead stub, not a mechanism.
  `#btn-join-faces` is in no `index.html`; `app-join.js` hides it if it ever
  appears; `state.joinUseFaces` is read in two places and written only to
  `false`. What Join actually does when a slot is armed is
  `capturePlanarFace(hit)` (app-finish.js): it refuses the top ("Click a
  side wall, not the top"), returns a DISPLAY-space wall (`axis` x|z, `sign`,
  `worldTris` for the cyan highlight) and parks it in `state.joinFaceA / B`
  - session state, dropped by Cancel Join, shown only in the slot label, and
  consumed by nothing else (grep). Three reasons it is not the base for a
  target face: wrong space (world/display, not the piece's raw plane), wrong
  scope (a session, not the piece), and it is a second face resolver next
  to `nsoFaceFromHit` - the "second mapping" the paint rule above forbids.
  It was left exactly as it is.
- *The reusable picker is the paint's.* `nsoFaceFromHit` (one answer to
  "which face"), `faceUnderCursor` for a curved patch, the entry shape
  `{n, d, axisIdx, keepMin, dispAxis, dispSign, dispPlane, inner}`, the
  overlay that lights faces by the axis / side / plane the click recorded,
  the click-ownership predicate `nsoMaskTakesClick`, and the `maskReplace`
  undo. The select is built on all of that, as a second list on the same
  object.
- *Skin's auto-pick* is direction only: `NSO_skinDirForModel` gives raw +Z
  outside a Join and the A-centre -> B-centre direction inside one, and
  `NSO_Skin.findFace(soup, dir)` takes the coplanar group within 30 degrees
  of it, best dot, then the OUTERMOST plane. So it could never name a pocket
  floor, and it had no input other than the direction. An explicit selection
  therefore **overrides** the auto-pick, it does not coexist with it: Skin
  takes exactly one face, the selection is that face when there is one, the
  direction pick is the fallback when there is none, and the status line
  says which (`target: selected target` / `auto-pick: faces B` /
  `auto-pick: top face`). Paint still wins over both: a target that is also
  excluded stands Skin down by name.

**Two flags, two questions (Task 2).** `m.faceMask` now carries
`exclude: []` (unchanged: any number of faces, yellow, every bake's skip
list, `nsoMaskIsExcludedRaw` / `nsoMaskFaceList` / `nsoMaskCount`) and
`select: []` (new: at most ONE face, pink `#f472b6` - the colour no other
per-piece marker uses - read through `nsoMaskSelected(m)`, count
`nsoMaskSelectCount`, membership `nsoMaskIsSelectedRaw`, consumed with
`nsoMaskSelectClear(m, {noUndo})`). Same entry shape, same pick, both stored
as planes so both survive a bake. A face may be on both lists; that is two
true answers, not a conflict. `nsoMaskSnapshot` returns `{exclude, select}`
and `nsoMaskRestore` takes that or the older bare exclude array, so every
existing undo entry and test still restores. `state.maskPaint` is now
`false | 'exclude' | 'select'` - truthy while either session is live, which
is all app-core's click routing ever asked.

**The paint row (Task 3)**, Finish tab: **Paint Selected** (`#btn-mask-select`)
/ **Paint Excluded** (`#btn-mask-paint`, the old Paint faces) / **Clear
paint** (`#btn-mask-clear`, now drops BOTH lists). Paint Selected is
single-target: a click on a face makes it the sole target, a click on another
face moves the target there (status says `replaces the Y+ face`), a click on
the current target clears it. Multi-select was not built: Skin is the only
consumer and takes one face; a consumer that needs more adds a list, not a
meaning. Each click is one `maskReplace` undo step.

**Moved into the Finish tab (Task 4)**, directly under the paint row: `Skin
face` + the pattern select (were on the Join card), and `Cap open faces` (was
on the Join card). All three are bound by id (`app-skin.js`,
`app-join.js` setupUI), so nothing was rewired. The one consumer that did
break was the tests: a control inside the Finish `<details>` is not visible
to Playwright's `page.click` until the menu is open, so
`tools/nso_app_harness.js` gained `openFinishMenu(page)` (clicks the
summary, idempotent) and the four suites that press Skin
(`nso_skin_test`, `nso_skin_drive_check`, `nso_poslock_test`,
`nso_multi_export_check`) call it first. The skin drive also asserts the
new placement (`.vp-finish #btn-skin-face`, none of the three left in
`#join-card`). The cth capture check drives paint through `#btn-mask-paint`
and `!!state.maskPaint`, both unchanged.

**Drive check (Task 5)**, `tools/nso_face_select_test.js`, through the
shipped controls, A = box_hull_80x40x20-2 with B = box-20mm BESIDE it on +X
so the auto-pick has a wrong answer to give:
- no target, Skin face -> `Skinned +X face ... target: auto-pick: faces B`,
  A's raw X 80 -> 80.6, Z stays 20. Undo.
- Paint Selected, a real `mouse.click` on A's top in the viewport (the aim
  is asserted first: the app's own ray from that client point lands on that
  piece's Y+ face, and `elementFromPoint` is the canvas) -> one select entry,
  raw +Z at d = 10 (the fixture is centred), exclude list still 0, pink on
  2 tris, HUD `target Y+ face`. Skin face -> `Skinned +Z face ... target:
  selected target`, raw Z 20 -> 20.6 and **X stays 80** - the selected face
  got the relief, not the one that looks at B. Export plate: the downloaded
  STL's hull shell is 80 x 40 x 20.6, two shells, 0 open. Undo (button)
  puts back geometry AND target in one step (the commit's `prevMask`).
- one target at a time: +X replaces top, same face again deselects, undo of
  a select is its own step.
- paint wins: Paint Excluded on the same top -> both lists hold it, yellow
  and pink both drawn, Skin -> `Skin stood down - +Z face is painted`.
- Clear paint -> both lists empty; Skin falls back to the auto-pick (+X).
- an inner face: the Node part's 30x30x10 block with a 20x20x5 pocket is
  written to disk and loaded through the file input; a click on the pocket
  FLOOR records `inner: true, d = 5`; Skin face skins the floor, height stays
  10, status `Skinned inner +Z face`. With no target the auto-pick finds the
  rim and refuses it (not a rectangle) - the same piece Skin could not touch
  before.
- Cap open faces from its new row answers `No open face to cap` on the hull.

Known limits, stated not solved: the overlays draw for the ACTIVE piece
only (as the yellow always did), so a target painted on a non-active piece
is recorded but not lit until that piece is selected; the select is
in-memory like the paint, not in the STL or 3MF.
