## Feature fixtures - known functional features on one hull (2026-09-26)
Branch `claude/feature-fixtures`, off `claude-wip`. Full write-up:
**`docs/FEATURES.md`**.

- **What it is:** `tools/nso_features.js` puts a flange, a handle, a bracket, a
  lid and a hinge on one 120 x 70 x 40 hull. Each is built from an explicit
  geometric definition and comes with its ground truth: its root (where it
  meets the hull), its cell, its volume, and the census the checker must read.
  It reuses `nso_damage.js`'s architecture and calls its helpers, which are
  now exported.
- **Detector fix, `nso_flange.js`:** the round-rod handle read as a 7.7 mm
  flange. New clause **sheet**: eroded by t/2, the core must still reach 3t.
  `flange:test` still passes 48/48, and a rescan of all 103 repo STLs gives
  the same table as before.
- **Definition finding:** a bracket without gussets **is** a flange by the
  rule. So `bracket` requires the gussets, and the unbraced shape (`angle`)
  is pinned as a flange.
- **Reference detach / reattach** (`FX.detach`, `FX.reattach`) is the ground
  truth for the Detach / Reattach ticket. It is exact and cut-free; a kernel
  cut on the root plane leaves a zero-thickness sheet of face behind.
- **Library:** six rows under Test Fixtures, with the files in nest-library
  (landed there first, nolongerzzz/nest-library#3).
- **Checks:** `features:fixtures`, `features:test` (114 with a nest-library
  checkout). All seven fixtures pass `stl_watertight_check.py --odd --degen`.
- **`?v=` not bumped** (rule 4): `app-library.js` and `nso_flange.js` need a
  bump at merge.
