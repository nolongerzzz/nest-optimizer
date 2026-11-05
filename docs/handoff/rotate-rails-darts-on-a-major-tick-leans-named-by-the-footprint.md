## Rotate rails - darts on a major tick, leans named by the footprint (2026-10-17)
Branch `claude/rotate-rails-orient`, off `claude-wip`. `app-rotate-handles.js`,
the Rotate card's three tooltips and comment in `index.html`, `rotate:handles`
sections 19-24. UI only: no pose maths, no export, Undo or Tilt behaviour touched.

- **Darts.** Each ring's arrowhead pair sits on a MAJOR (45 degree) tick of its own
  scale - the one nearest the camera (the camera's angle about the ring's axis,
  in the ring's frame, rounded to 45) - and nowhere between ticks. It stays there
  until the camera is 22.5 + 10 degrees (`SEAT_HYST_DEG`) from it, then re-seats
  to the nearest tick (`seatFor`; memory in `seatIdx`). The camera is watched
  through OrbitControls' `change` (hooked from `refresh`), which redraws only when
  a dart is actually due to move. Looking straight down a ring's axis they stay put.
  A drag still carries them under the pointer; releasing seats them again.
  A click on a dart or an arrow key turns the PIECE 1 degree (Shift: 0.1) and the
  darts stay on their tick - they no longer nudge along the ring (`arrowAt += step`)
  with it. Shift reaches `beginDrag` as a 6th argument from app-core's press handler
  (`event.shiftKey`); a Shift-drag is an ordinary drag.
- **Names follow the footprint.** The ring ids stay AXES - `fb` = the piece's own X,
  `ss` = its own Z, which is what Tilt (`nsoRotate.turn('fb'|'ss')`) and every older
  check call them, so Tilt and the 90 buttons are untouched. What moved is the
  look-up of name, colour, card row, readout and tooltip (`LOOKS`, `leanMap`,
  `roleOf`). "Lean front/back" is the ring that tips the piece ALONG the long side
  of its footprint: the footprint is the mesh's box on the plate (`p.width x p.depth`,
  measured off the mesh each time, so a bake or Scale cannot leave it stale), and
  the ring is the one whose axis lies the more nearly on the horizontal line across
  that long side. Within 5% of square (`SQUARE_WITHIN`), or where neither axis
  decides (a piece stood on an edge, so that one lean axis is vertical and the other
  is the long side), the old mapping stands: front/back = own X.
- **The row follows the ring.** `shown` is keyed by ring; the three card rows are
  views of it (`syncBoxes`), so when a Turn changes what a ring is called the tick
  moves to its new row and nothing disappears. Names are held for the length of a drag.
- **Seen, not changed.** The 5% band is on the box, so a long bar yawed through 45
  degrees (box square) passes through ~5 degrees where the names revert to the old
  mapping and then flip back. During a drag they are held; at rest they follow.
  A footprint measure that sees the bar's own direction would not flip, but the
  ticket asked for the box and the 5% rule.
- `?v=`: `app-rotate-handles.js` helpmrg1 -> rails2 and `app-core.js` leashb7 -> leashb8, on the ticket's instruction
  (rule 4 above says otherwise by default).
- Checks: `rotate:handles` 19-24 (darts on 8 azimuths per ring, the hysteresis sweep,
  a 60x20 piece lying and turned 90, square / near-square / 8% cases, Roll, Tip, Scale,
  a bake, the held names, the card rows and tooltips, Undo of a lean).
  There is no `rotate:rails` script in this tree.
