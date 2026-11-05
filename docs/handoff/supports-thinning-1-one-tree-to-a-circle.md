## Supports thinning 1 - one tree to a circle (2026-10-25)
Branch `claude-wip`, engine only: `nso_support_gridpack.js` (`crownTopology`, `plan()`'s `crownPlan`, `stepCrown`,
`growCrownTrunk`, `opts.crown` knobs), `tools/nso_support_feed_check.js` (section 4 rewritten, section 7 new: 58 checks),
`tools/nso_support_bambu_joins.js` (new: Bambu's joins measured from its G-code), `tools/nso_support_crown_export.js` (new:
simple_overhang from Custom to `tools/supports-crown-out/`), `docs/SUPPORT-GRIDPACK.md` section 8. No UI, no
interface file, no pad / flare / hollow change.

- **Custom feed with circles: one trunk to a circle.** The circle's tips are split by position (nearest pair up, then
  nearest nodes, 2 - 3 to a join: 6 tips are 1 > 3 > 6, 12 are 1 > 3 > 6 > 12), the trunk stands on the circle's centre
  (else the nearest point where it fits), oval along the tips' spread (area = the round law's, aspect 1 - 3).
- **Joins are Bambu's**: area kept (parent = sum of children, measured 0.97 - 1.09), branches hold their width between
  joins, branch angle at most 47.7 deg (measured max), design lean 23.9 deg. Numbers in `docs/SUPPORT-GRIDPACK.md` 8.
- **The lean limit marks**: `plan.overLean`, `plan.suggested`; no tip is dropped in Custom (`offZone` / `unmerged` /
  `unreachable` empty); Auto and Assisted keep the old paths.
- **The arc's stair** (interface, unchanged) is grafted on the circle's trunk: one trunk to a circle.
- **Rail probe stays**: a branch with no way round the part is not built and is listed in `plan.blocked` with its tips -
  OPEN for the owner: tips are held but that branch is missing.
- **No new constant is hard-wired**: every crown value is an `opts.crown` knob with today's value as the default.
- A tip is moved off a wall only where it touches it (`nudgeMarginMm` 0); the planner's 0.2 margin broke the arc's stair.
