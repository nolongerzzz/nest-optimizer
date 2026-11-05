## Position lock (2026-09-16)
`app-poslock.js`, the **Lock position / Unlock position** button in the
viewport bar (`#btn-lock-pos`). Check: `npm run lock:test`
(`tools/nso_poslock_test.js`, in `npm test`, 74 checks).

**Audit first - nothing existed.** `grep -in lock` over the loaded scripts
hits three things, none a piece lock: app-ux.js's "Look locked" (the orbit
target, camera only), Join's "Lock faces (optional)" (`state.joinUseFaces`,
the face-pick mode), and `setCutAxisLock` (the cutter axis). The two
per-piece user-set flags that do exist are mask6's paint
(`m.faceMask.exclude`, app-mask.js) and the non-solid flag (`m.nonSolid`,
app-nonsolid.js): both live on the model object, both have one accessor,
an undo entry and a list tag. Nothing gated any move path: `startMoveDrag`
checked only `state.cutterOpen`; `nudgeSelected`, `liftSelected` and the six
pose functions checked only that a piece was selected. So this is built on
the non-solid shape, not on a new one.

**What it is.** `m.posLock` on the model (so it survives every bake that
swaps `p.mesh`), read through `nsoPosLocked(m)` / `nsoPosLockedPlaced(p)`,
set only by the button through `nsoPosLockSet`, undo type `posLockReplace`.
The gate is `nsoPosLockBlocks(p, verb)` at the top of the nine move paths in
app-core.js: `startMoveDrag`, `nudgeSelected`, `liftSelected`,
`rotateSelected`, `flipSelected`, `tipSelected`, `rollSelected`,
`bankSelected`, `tiltSelected`. Locked: the call returns, nothing moves, no
undo entry, status `Locked - drag refused on <name> - press Unlock position
to move it`. Indicator: `locked` tag on the list row, a teal edge outline
as a child of the mesh (re-attached by `nsoPosLockRefresh`, which
`renderModelList` and `updateAdjustUI` call, so a bake's new mesh gets it
back), the 15 move/pose toolbar buttons greyed while a locked piece is
selected, adjust-status `Locked #n`.

**What it deliberately does not block:** Seat flush, Seat (support), Center
X / Z, Align edges, Skin face, the library's seat-on-arrival, Undo. None
read the flag. Lock after Seat has placed the piece; Seat on a locked piece
still seats it, because the user pressed Seat. A clone of a locked piece is
a new model and starts unlocked. In-memory only, like the paint: not in the
STL or the 3MF.

**Validation, real interaction.** Playwright's mouse pressed on the locked
piece and pulled 80 px: every pose field and the world box unchanged, no
undo entry, no drag left armed, status names the refusal; the same gesture
unlocked moves it 29.773 mm and reports `Moved model #2` (the control), and
Undo puts it back to 1e-9. The nudge primitive, Raise/Lower and the six pose
functions each leave the locked piece unchanged and name the refusal; the
four arrow keys are a no-op (the app binds no nudge keys - pinned). Seat
(support) on a locked B: seated, liftY 20.18, 0.18 above A to 2e-6, still
locked. Skin face on a locked A: baked (28 -> 34,596 tris), x/z untouched,
lock and outline on the new mesh. Export with A and B locked, C free:
34,620 tris, 0 open, 0 non-manifold, Euler 6, 0 piercing, 0 coplanar, B
0.180000 above A's tips; the STL is **byte-identical** (1,731,084 bytes)
with nothing locked and again with everything locked.
