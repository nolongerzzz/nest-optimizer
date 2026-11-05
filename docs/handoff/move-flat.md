## Move is flat; the grab is Lift's drop alone (2026-10-23)
Branch `claude/move-flat`. Full write-up: **`docs/MOVE.md`**.
- **A plate drag is XY only** (`app-core.js` `dragMovePlaced`): height never
  changes during it; no ray, box or vertex is read on a pointer move; the
  release settles the piece's lowest point once (`settlePlacedOnBed`, from the
  cached pose bounds); overlap is allowed; Escape puts it back (no Undo); one
  `movePlaced` Undo. The Join flush readout (`reportJoinFlushGap`) runs once
  on the release, not on every move.
- **The grab (`app-grab-drop.js`) is Lift's**: `NSO_LIFT_PLATE.ownsDrop(p)`
  (a piece Lift left in the air, while `liftY > 0`) is asked at the press;
  nothing else begins one on the main plate. G-scope's plate is unchanged.
  What it did on the plate: stack -> Seat, butt -> Join, attach -> Connect.
- **The box over a piece** while dragging with Align up was the grab's target
  helper; gone from Move. The red fence lines (footprints of the other pieces)
  stay.
- **Checks:** `grab:drop` rewritten (flat drag + Lift's drop, 53 gates);
  `watch:test` H and `split:parts-drive` follow. `npm run move:bench` times it.
- **Files:** `app-core.js`, `app-lift-plate.js` (`ownsDrop`), `app-grab-drop.js`
  (header only), `app-split-parts.js` (comment only), `docs/MOVE.md` (new),
  `docs/GRAB-DROP.md`, `docs/LIFT.md`; checks `grab:drop`, `watch:test` H,
  `split:parts-drive`; `tools/nso_move_flat_bench.js` (`npm run move:bench`,
  a measurement, not a step - so no `tools/test-weights.json` entry).
