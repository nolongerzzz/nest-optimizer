## Feature size in Scale, and Step / Boss on ADD - one tab or slot resized; an outline stood out of a face (2026-11-16)
The owner's ask, on the A1 Mini tool-head lock: the risers were scaled, their
slots shrank (25.2 → 20.29), the lid's 25 × 5 × 4 tongues no longer fit; and a
way to add a pop-out / step / angled thickening to a wall. Chosen: sizing in
**Scale** (ghost, live, mm box like Scale's); the step as its own editor on
**ADD**, not on Assemble or Interlock.
- **Feature size** (`nso_feature_size.js`, `app-scale-feature.js`,
  [docs/FEATURE-SIZE.md](../FEATURE-SIZE.md)): button at the foot of the Scale
  card. Click a feature (Shift-click more), Length / Width / Height (Depth)
  boxes + sliders, green ghost, Set / Enter = one Undo (`featureSizeReplace`),
  Cancel / Esc. Keep ends | Stretch. Raised or recessed found by a walk that
  stops at concave (or convex) creases > 20°. Only the feature's vertices move;
  a foot grown over the face's corners re-lays the flat face (NSO_CDT). A
  pierce gate (NSO_Repair.inspect, as Thicken) refuses growth into the piece.
- **Step / Boss** (`nso_boss.js`, `app-boss.js`, [docs/BOSS.md](../BOSS.md)):
  `#btn-boss` on ADD (`data-asm-mode="boss"`). Rectangle / Round / Drawn
  (points dragged on the face; Use Custom shape takes the Custom shape card's
  outline), Height, Ramp° + thin end (a ledge with a sloped underside, or a
  wedge), a-d distances, Turn, drag. Apply = one Undo (`bossReplace`).
- **app-asm-editor.js:** SOLO modes (`solo: { title, returnTo }`): no tab on
  Assemble; opened on one, the editor wears its title and hides the tabs.
  `toolShare` / `commitShare` / `soupVolume` moved here from
  `app-asm-interlock.js` (which calls them, its words unchanged) and are on the
  kit. `#asm-ed-title` has an id; `.asm-ed-tabs[hidden]` hides.
- **Wall faces are upright on Step / Boss** (v up the wall, so a = top); the
  editor's own frame (and Interlock's) is unchanged.
- Fixtures: `tools/nso_feature_fixture.js` builds both test pieces (a plate
  with two tongues, optionally eased or with a stray corner; a block with a
  slot) from their definitions.
- Checks: `npm run feature:size`, `npm run boss:test` (node, testSteps);
  `npm run scale:feature`, `npm run boss:drive` (driveSteps). Re-ran
  `asm:interlock`, `asm:editor`, the scale drives.
- **Not done:** a feature foot on a curved face; a step over a face edge; a
  pocket of a drawn outline; a draft on step sides.
