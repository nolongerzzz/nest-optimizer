## Lean after Tip - the lean darts lean about the footprint's level sides (2026-10-21)
Branch `claude/lean-after-tip`, off `claude-wip`. `app-rotate-handles.js` (the axes),
two comments in `app-core.js` (Tilt), the Rotate card's two lean tooltips and comment
in `index.html` (text only, no layout), `rotate:handles` section 26, `tip:orient`
and `pose:drive` re-pinned where they pinned the old axis.

- **The bug.** Fresh piece, Tip on side, click a lean dart: it turned about the
  vertical. `frameOf` / `turned` read the lean axes as the piece's own X and Z
  (`RINGS.fb.local = [1,0,0]`, `RINGS.ss.local = [0,0,1]`, postmultiplied:
  `q0 * R(local, d)`). Tip is a world quarter turn, so after it own Z stood
  upright (`ringAxis('ss')` read `[0,-1,0]`) and the 'ss' lean was a yaw. Nothing
  re-read the axes after Tip; they were never anything but the import-pose axes
  carried along.
- **The rule.** The two lean axes are the sides of the piece's footprint as it
  lies NOW - level lines in the plate plane (`leanAxes`): the narrowest rectangle
  round the shadow of the mesh's bounding-box corners, its sides tried along the
  shadow of each of the piece's own axes. 'fb' is the side nearer own X's shadow,
  'ss' the other, signed with own X / Z. Read at every press, click step, key
  step, Tilt press and redraw, so after every Tip, Flip, Turn, lean and bake;
  held for the length of a drag (`drag.F`). A lean is `R(A, d) * q0` about that
  world axis. A lean axis is always level - never within 45 degrees of vertical -
  and Turn is the only control that turns about the vertical.
- **Untipped is unchanged.** On a piece lying as loaded (only Turns), the
  footprint sides ARE own X and own Z, signs included, so every single lean is
  bit-for-bit the old `q0 * R(own, d)`: pinned in section 26 (fields and
  quaternions for fb/ss 10 and Turn 45 then fb/ss 10, and a dragged dart).
- **What does change - owner's call.** A lean on a piece ALREADY leaned the
  other way: before, about the tilted own axis; now about the level footprint
  side. fb 10 then ss 10 on a 40x20x10 box: fields (10, 0, 10) before, (9.851,
  1.728, 9.851) now; the second lean no longer twists the heading. The Tilt
  buttons share the rings, so Tip on side then Tilt was a spin and is now a
  lean (`pose:drive` 2b), and a Tilt on a piece rolled 45 goes about the level
  line (`pose:drive` 4, `tip:orient`). The alternative - own axes while they are
  within 45 degrees of level, the footprint only past that - keeps compound
  leans as they were but jumps the ring 45 degrees at the threshold, and on
  Turn 45 then Tip (the box balanced on an edge, own X and Z both at exactly 45)
  it is a coin toss.
- **Names.** `leanMap` is unchanged (still the box `p.width x p.depth` and the 5%
  rule); it now compares the box's across-line with the new axes. After Tip on
  side and after Turn 45 then Tip, front/back is the ring across the long side.
- Checks: `rotate:handles` 26 (Tip on side, Tip X, Flip, Tip then Flip, Turn 45
  then Tip; a 10 degree drag and a real click on each dart: turned exactly that about a
  level axis, the upright axis 10 degrees off vertical where there is one, one side up
  and the other down, yaw - the twist about the vertical - 0 within 0.1 degrees, the
  footprint heading too where the piece rests on a face; the old axis's 10 degree yaw
  shown for the record; names on the tipped piece; untipped pins); section 1 now
  also asserts every lean axis level over 245 random poses. `rotate:drive` and
  `rotate:pivot-drive` (not in `npm test`) die at their section 4 drag with
  `handleScreen` null on `claude-wip` as it is, before this change; not touched.
- `?v=`: `app-rotate-handles.js` detents1 -> leantip1, `app-core.js` punchb16 ->
  leantip1, on the ticket's instruction. `testStepWeights` `rotate:handles`
  255000 -> 275000.
