## Lift reads any face (2026-10-15)
Branch `claude/lift-any-face`, off `claude-wip` after #190. Full write-up:
**`docs/LIFT.md` §7, "Any face"**.
- **What changed:** while Lift is armed the base face is the face under the
  cursor (`app-lift-plate.js`). A side wall is read looking down its own normal;
  the card's count, Pick and Strip follow it. The top stays the default (arm
  time, the cursor off the piece), read exactly as before. One read per face,
  cached per soup. "Nothing stands out from this face." goes on the card only.
- **Engine:** one guard in `nso_lift_auto.js` (`judge`): an island with no
  boundary loop - a free shell standing off the face, as the hinge's moving
  leaf does - threw on `big.area`; it is the `loops` refusal now. Nothing else
  moves; the rest of the engine's tests were not re-run for this change.
- **Checks:** new `lift:any-face` (feature-hull_hinge: top 0, +Y wall 1, lift
  it, one Undo, grab-drop; the Barocke plate's top unchanged). `lift:plate`
  unchanged and green.
- **Tags:** `app-lift-plate.js` and `nso_lift_auto.js` -> liftanyface1.
