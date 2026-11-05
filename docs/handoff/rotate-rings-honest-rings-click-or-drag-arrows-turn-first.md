## Rotate rings - honest rings, click-or-drag arrows, Turn first (2026-10-11)
Branch `claude/rotate-rings`, off `claude-wip`. `app-rotate-handles.js` is
rewritten; the 45-degree scrolling arc, the trackball and the X/Y lock boxes
are gone. Three full rings about the PLATE's axes (Turn = vertical, Lean
front/back = plate X, Lean side/side = plate Z), drawn with no depth test,
each carrying two arrowheads: a click is exactly 1 degree, a press-and-drag is
a dial round the ring. Turn only on every opening; the three boxes add rings
for that session and are not saved.

- **The math.** Every step is `R(axis, d) * q0`, decomposed back into the pose
  fields in applyMeshRotation's XYZ order, taking the Euler reading closest to
  the current fields (so a yaw through 90 reads rotY 100, not THREE's
  (180, 80, 180)), and holding z at gimbal lock. `tipX` / `tipZ` / `flipX` are
  never written - they stay whole quarter-turn counts.
- **Direction.** The dial's screen angle times `sign(look . axis)`: clockwise
  on screen is clockwise on the piece from either side of a ring.
- **Snap.** Hard, only within 3 degrees of a quarter turn, only while dragging,
  one flash on landing. The angle it snaps is measured, not read off rotY: the
  piece's axis lying most nearly in the ring's plane, projected into it.
- **Export order fixed (separate commit).** `buildCombinedGeometry`,
  `buildPlacedObjects3MF` and `NSO3MFScene.poseBasis` now compose Z, then Y,
  then X - Rx*Ry*Rz, the screen's order. They composed X, Y, Z, which agreed on
  one axis and not on two (the open finding `pose:bake` section 5b printed).
  Old files restore unchanged: they carry their own `basis`.
- **Still open, proposed not patched:** the 90-degree buttons add to rotY, the
  middle of the chain, so on a leaned piece they turn about the leaned axis -
  the same disagreement the rings fixed, left alone because the ticket keeps
  those buttons as they are.
- Checks: `rotate:handles` rewritten (12 sections); `rotate:drive`
  (`tools/nso_rotate_rings_drive_check.js`) is the ticket's drive-check with
  screenshots into a fresh OS temp dir (outside the repo; its 14 PNGs that
  were once committed under `docs/rotate-rings/` were removed), not in
  `npm test`. `?v=` not bumped
  (rule 4): `app-rotate-handles.js`, `app-core.js`, `nso-3mf-scene.js` and
  `styles.css` change under their current tags.
