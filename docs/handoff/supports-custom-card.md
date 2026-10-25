## Supports custom card - the Tune section (2026-10-25)
Branch `claude/supports-custom-card`, on `claude-wip` 525e244. UI only: `app-supports-card.js`, `index.html`
(new ids only), `styles.css`, `tools/nso_support_custom_drive_check.mjs` (section 9), `docs/SUPPORTS-CARD.md`
section 7. Built against supports-knobs-1's `feed.knobs` (#294, not in `claude-wip` when this was written).

- **Custom only**: a collapsed *Tune* section with four fields (trunk top mm 2, trunk growth deg 5.5, lean
  limit deg 30, node spacing mm 5) in the card's Angle / Size style. Hidden in Auto and Assisted; the values stay.
- **REGENERATE is the Set button**: typing builds nothing; a build that no longer matches the fields is stale
  (readout dimmed and worded, REGENERATE outlined). The feed gets `knobs` with only the fields off their
  default, none when all four are at default. **Defaults** puts all four back.
- Settings like the angle: not an Undo step, not on the piece, kept by mode changes, REMOVE ALL, Undo and Escape.
- Proof: `support:custom` section 9 (`--only=tune` for that alone). It reads the worker's reply, so it needs
  #294 in the tree.
- Not done: the export name tag, `plan.knobs.problems` on the card, dimming the supports in 3D.
