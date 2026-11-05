## Rotate rings - steady radius, quieter rails, degree markers, piece-frame leans (2026-10-12)
Branch `claude/rotate-rings-steady`, off `claude-wip`. Changes to
`app-rotate-handles.js` (plus two tooltips in `index.html`):

- **The leans are the piece's own axes** (owner's correction, applied before
  the ticks). Turn stays about the plate's vertical, pre-multiplied. Lean
  front/back is the piece's own X, its length - its ring lies ACROSS the piece
  and rolls it, the front edge going up or down; Lean side/side its own Z, the
  width line - its ring runs ALONG the piece and tips it end-over-end. At rest
  that is #135's rings exactly (plate X, plate Z); the owner confirmed the
  mapping by picture. Both are post-multiplied (`q0 * R(own axis, d)`) and
  decomposed into the pose fields as before. Their rings are drawn in the
  piece's frame (`frameOf`), so they turn with it and the ring you grab is the
  motion you get; Turn's stays level. A lean ring's scale keeps its 0 on the
  level line in its plane (`up x A`), which a turn about the ring's own axis
  leaves where it was. Turn a bar 45 and lean it side/side 30: its long axis
  rises 30 at heading 45, no twist (the old plate-Z lean swung it to 49.1).
  Tip's Tilt buttons are being moved onto `nsoRotate.turn('fb'|'ss', +/-15)`
  in claude/pose-buttons-plate-axes.
- **Radius from the bounding sphere.** 1.45 x the largest distance from the
  mesh's origin (the point every turn is about) to any vertex of its own
  geometry, floor 8 mm. Rotation-invariant, so the rings no longer breathe on
  a bar. Cached per geometry in a WeakMap keyed on the position attribute's
  version and count - a bake, Scale or Cut measures afresh, a frame never does.
- **Quieter while dragging.** Active ring 0.6x tube and 0.35 opacity, the other
  two at 0.12, the held arrowhead at full weight; a press that has not moved
  is still a click and leaves the rails at rest. Colours unchanged.
- **Degree markers.** One LineSegments per ring: 24 ticks on the outer edge,
  short / 45 / quarter lengths. Labels 0 90 180 270 as sprites (sizeAttenuation
  off, so screen-sized) in the ring's colour, 9 degrees past their tick along
  their own ring - the three rings cross on the axes, so every quarter of one
  ring is a quarter of another and centred labels printed over each other.
  All in the ring's own e1/e2 frame, the frame the snap measures in, so a
  snapped quarter turn lands on a labelled tick.
- Checks: `rotate:handles` gains sections 13-16 (143 gates);
  `rotate:steady-drive` is the ticket's drive-check, screenshots in a fresh
  OS temp dir (outside the repo, path printed; pass a dir to keep them
  elsewhere), not in `npm test`. `?v=` bumped on the owner's
  instruction (as in 3d42873): `app-rotate-handles.js` rot3 -> rot4.
- Seen, not changed: a freshly dropped piece rests 0.1 mm higher than a posed
  one (the open finding at `snapshotPlacedPose`), so the first turn lowers
  the ring's CENTRE 0.1 mm. Not the radius; the drive-check settles first.
