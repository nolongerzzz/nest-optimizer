## Detach / Reattach - a detected flange off the hull, and back on elsewhere (2026-09-26)
Branch `claude/flange-detach`, off `claude-wip`. Full write-up:
**`docs/DETACH.md`**.

- **What.** Cut menu, below Crop. **Detach flange**: `NSO_Flange.detect`,
  then `NSO_Detach.detach`. The piece becomes the hull, capped flush on its
  own neck wall, and the flange lands beside it as its own closed piece.
  **Reattach**: an armed click, seated by Assemble's `attach` (measured
  seat, length kept) and unioned. One Undo each (`featureSwap` in app-core).
- **The audit.** Detection's plane was enough for the flange, not for the
  hull: v9's neck wall is three planes, stepping 10 µm at each Mirror-Join
  seam. One cut keeps a 13.5 / 22.5 µm skin of flange, or it shaves 20.5 µm
  off the wall. `refineRoot` now reports `cut.pieces`. The hull is one
  `rawCut` per piece (`rawFlatCapLoops`), spliced at the seams by Crop stage
  1's `NSO_cropSeal`. No new cap maths.
- **Attach took a real piece with three opt-in additions**, each measured on
  v9. `footAt`: the tip-nearest foot aimed the flange 87° off and 58.9 mm
  deep. `up`: the shortest turn stands a plate on end. `extendRaw:
  NSO_Detach.extendRoot`: Extend refuses a flange. Defaults unchanged.
  `NSO_SupportAim.lineBlockedAt` is now public (nearestBase's own line test).
- **Acceptance** (`detach:test` §2-3): the v9 hull PASSES with
  self-intersection, 0 µm past its wall, the source bit for bit away from
  the root. The flange is the Flange tab's, bit for bit. Reattached at the
  mirror-opposite: one solid, PASS with self-intersection, contact at the
  seat only, **0 of 48,654 triangles off the two input surfaces**. Crop
  stage 2 (PR #114), run in the same test on the same relocation: 3,091
  triangles (90.8 mm²) off them, its bridge.
- Checks: new `detach:test` (57), `wire:detach` (28, a real canvas click).
  `paint:scope` roster + this file's roster: Detach and Reattach, whole-piece.
- **Base:** `claude-wip` at `eec6bcc` merged in (Stage 2, the cache-tag batch
  and the five older drifts).
- **`?v=` not bumped** (rule 4). `nso_detach.js` / `app-detach.js` are new
  at `?v=detach1`. Five tagged files change here and drift from their tags,
  so they need a bump at merge: `nso_flange.js` (flange1),
  `nso_assemble.js` and `app-assemble.js` (asm1), `nso_support_aim.js`
  (support2), `app-core.js` (gsup3).
- **Not yet:** features other than flanges; the 7.4 mm³ sliver between the
  flange's flat root and the hull's staircase belongs to neither piece;
  Reattach refuses rather than trims a placement that runs into the body.
