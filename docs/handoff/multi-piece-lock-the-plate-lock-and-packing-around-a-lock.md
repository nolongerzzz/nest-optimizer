## Multi-piece lock, the plate lock, and packing around a lock (2026-09-16)
`app-poslock.js` (the plate lock and the HUD line it owns), `app-core.js`
(`state.plateLock`, the `plateLockReplace` undo, and `runOptimize` /
`packModels`), `app-mask.js` (one line, so the HUD stops clobbering the lock),
`index.html` / `styles.css` (the second button). Check: `npm run lock:multi`
(`tools/nso_multilock_test.js`, in `npm test`, 83 checks through the shipped
controls in headless Chromium). The original `npm run lock:test` (74 checks) is
unchanged and still green.

**Audit first (Task 1), and the report it came from was wrong on both counts.**
The ticket said "only one piece can be locked at a time" and "no way to
select/drag other pieces while one is locked". Driven in the real app:

- *The flag was never one-at-a-time.* `m.posLock` is one boolean per model
  object; nothing anywhere holds "the locked piece", there is no plate-level
  or module-level lock variable, and `syncOutlines` / `syncListTags` already
  loop over every piece. The shipped `nso_poslock_test.js` had A **and** B
  locked at once, and then all three, before this ticket existed. Lock A,
  lock B, lock C in turn: each lands on its own model, and at every step the
  pieces not yet locked are selected by a real click and moved by a real
  80 px drag (40.0 mm, 35.5 mm, 34.6 mm). Section 1 of the new check pins
  this.
- *Nothing freezes the viewport.* The first read said otherwise, and the
  probe was wrong, not the app: it started its orbit drag at the canvas
  corner, which misses the plate, and `onCanvasPointerDown` only re-enables
  rotate when the ray hits plate. Aimed at a point the app's own ray test
  confirms is plate-and-not-piece, the camera moves with no lock (229),
  with one (260), with three (200), and immediately after a REFUSED drag on
  a locked piece (120). `state.controls.enabled` is never left false by a
  refusal - `startMoveDrag` returns before it touches the controls.

What the audit DID find, and what this commit is:

1. **The HUD line lost the lock on every selection** - a real bug, and the
   likeliest thing behind "no way to verify lock state". `app-sel-outline.js`
   wraps `selectPlaced` and calls `nsoMaskHudRefresh()` AFTER it, which at
   rest writes the bare `HUD inside4` tag into `#adjust-status` - straight
   over the `Locked #n` that `updateAdjustUI` -> `syncButton` had just put
   there. So the lock's own HUD line survived only until you clicked a piece,
   including clicking the locked piece itself. Fixed at the one writer:
   `nsoMaskHudRefresh`'s at-rest branch now asks `nsoPosLockHudLine()` first
   and falls back to the tag. The lock line also now carries the count, and
   says `N pieces locked elsewhere` when the selected piece is free but
   others are held - so several locks read back without selecting each one.
2. **`Optimize plate` was dead**, and had been since `3ff99f1`. `runOptimize`
   read `#opt-orient.checked`, `#opt-rotate.checked`, `#gap.value` and
   `#stats.classList`; not one of those ids is in `index.html` (the Pack card
   ships the button alone), so the first line threw and the button answered
   `Optimize failed. Check console.` every time. Pre-existing and nothing to
   do with the lock, but it is the nesting path the ticket says is blocked,
   so it could not be left. Every optional control is now read defensively
   with a conservative default: keep the uploaded orientation, do NOT yaw
   pieces the user placed (`allowRotate` false), 2 mm gap.
3. **A repack ignored the locks.** `runOptimize` rebuilt `state.placed` from
   scratch, so once it worked it would have relocated every locked piece.

**The plate lock (Task 3), deliberately a second concept.** `state.plateLock`,
one boolean, toggled by `#btn-plate-lock` ("Lock plate" / "Unlock plate") next
to the per-piece toggle. It holds the whole arrangement in one action and is
NOT "lock every piece": it writes no `m.posLock`, so
`state.models.map(m => m.posLock)` is byte-for-byte identical before it, under
it and after it - pinned in section 3. Three accessors, each with one meaning:

    nsoPosLocked(m) / nsoPosLockedPlaced(p)   this piece's own flag
    nsoPlateLocked()                          the arrangement is held
    nsoPosHeld(p)                             either - "cannot be moved"

`nsoPosLockBlocks(p, verb)` now reads the union and names which lock refused
the move (`Plate locked - drag refused on <name> - the whole arrangement is
held; press Unlock plate to move anything` vs the original piece wording, which
is unchanged to the character). The nine gated call sites in `app-core.js` were
not touched. Indicator: the plate border turns teal (`0x38bdf8` -> `0x2dd4bf`,
re-applied on every refresh because `buildPlateMesh` repaints it), the model
list gets `is-plate-locked`, all 15 move/pose buttons are greyed whatever is
selected, the per-piece toggle is disabled but still LABELS that piece's own
flag, and adjust-status reads `Plate locked - N pieces held...`. Undo entry
`plateLockReplace`, its own step.

**Packing around a lock (Task 2's real content).** `packModels` takes a fifth
argument, `blockers`: world XZ footprints the packer may not place on,
inflated by `gap` so a packed piece lands the same clearance from a locked
neighbour as from a packed one. `subtractFreeRect` cuts each one out of the
free-rectangle list up front (up to four surviving strips per rect).
`runOptimize` builds them from the locked pieces, asks `buildInstances` for
that many fewer copies of each model, keeps the locked pieces' `p` entries AND
their exact `mesh` objects (so a Skin/Soften/Repair bake on a locked piece, and
its lock outline, survive a repack of everything around it), clears only the
meshes being replaced, and restamps `placedIndex` on everything because the
held pieces come first in `state.placed`. Status: `Packed 1 model around 2
locked pieces, which did not move - ready to export`. With the PLATE locked,
the repack is refused outright before anything is touched - it is the one
non-move operation the plate lock blocks, because it is the one that rebuilds
the arrangement.

**Validation (Task 4)**, `tools/nso_multilock_test.js`, three `box-20mm`
pieces, every gesture a real mouse gesture:
- lock A, B, C one at a time; after each, every still-free piece is clicked,
  selected, its 15 toolbar buttons confirmed live, and dragged 80 px; orbit
  measured after each lock and after a refusal (all four move the camera).
- three locked at once: three tags, three outlines, `nsoPosLockCount() === 3`,
  three refused drags with no undo entry; unlock the middle one and it drags
  again between two locked neighbours while the other two stay locked.
- plate lock with exactly ONE piece lock underneath: all three pieces refuse a
  drag by the plate's name, the flag array is unchanged by locking AND by
  unlocking, after unlock the two unflagged pieces drag and the flagged one
  still refuses by its OWN name. Undo of the plate lock leaves the piece locks
  alone.
- all nine gated paths (nudge, Raise, Lower, yaw, edge, tip, roll, bank,
  pitch) refused on an UNFLAGGED piece under the plate lock, no undo entry,
  `Plate locked` named each time.
- Optimize with A and C locked: both keep their exact x/z and their exact mesh
  uuid, B is repacked to a new mesh, both outlines survive, no two footprints
  overlap, indices restamped, and B still drags afterwards. Optimize under the
  plate lock: refused by name, `[x, z, mesh.uuid]` identical for all three.
- export: the STL is byte-identical with nothing locked, with three piece
  locks, and with the plate locked on top - neither lock is in the file.

**Known limits, stated not solved.**
- `m.posLock` is per MODEL, so several placed instances of one model (what
  `quantity > 1` produces through Optimize) share one lock and cannot be
  locked apart. Clone makes a new model, so the clone path is unaffected, and
  the ticket asked for the flag to stay where it was built. A per-instance
  lock would have to move the flag onto `p`, which is the object a repack
  replaces.
- A piece loaded onto an already-locked plate is held too - the plate lock is
  one flag over `state.placed`, not a remembered set. The three indicators
  (greyed buttons, teal border, HUD line) say so; unlock to place it.
- The plate lock refuses movement, not deletion: Remove still deletes a piece
  from a locked plate, which leaves the rest of the arrangement intact.
- `Optimize plate`'s four missing controls are still missing from
  `index.html`. They are now optional rather than fatal; adding the card back
  would make auto-orient, yaw and the gap reachable again.
