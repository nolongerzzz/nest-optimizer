## Supports custom engine - the planner takes the user's points (2026-10-23)
Branch `claude/supports-custom-engine`, rebased onto `claude-wip` 1b45aec. Engine only:
`nso_support_gridpack.js` (`opts.feed`, `members()`, `shells()` / `shareFeet()`
answer with members), `index.html` (its tag), `tools/nso_support_feed_check.js`
(`support:feed`, new, in `testSteps`), `docs/SUPPORT-GRIDPACK.md` section 7. The
card that picks Auto / Assisted / Custom is the next ticket; nothing on the page
calls the feed yet.

- **No feed is today, byte for byte.** `opts.feed` absent, `null`, `{}`,
  `{ mode: 'auto' }`, `{ mode: 'auto', excluded: [] }` all take the old path. A
  side-by-side run of claude-wip 1b45aec's planner file and this one over the
  coupon, the standing clamp, the shelf, the tab and the arc (its stair) - every
  area bare, with the sheet, as the card builds it on shared feet, the pads by
  `shareFeet`, and the whole piece planned at once - hashed 43 of 43 the same
  (37 with a solid, 6 empty areas of the arc's).
- **The feed.** `{ mode, tips: [{x,y,z}], beaconsOff: [tip ids], landingZones:
  [{x,y,r}], excluded: [ids] }`. Auto takes only `excluded`; assisted plans
  detection's beacons (or the card's `opts.beacons`) less `beaconsOff` plus
  `tips`; custom plans `tips` only. A given tip is snapped to the nearest face
  within 1 mm and takes its normal; from there it is a detected beacon at that
  spot (same nudge, cap, sheet, gap). Tip ids: `b`/`u` + the point to 0.01 mm.
- **Landing zones**: a trunk's centre inside a zone's circle (pad and flare
  may spill past the line); members lean into
  reach of one (full lean then down, or one leg), merges / pickups that would
  leave reach do not happen; a merge / pickup that then lands in no zone is
  undone and its branches land alone (`plan.unmerged`), so only a tip no zone
  takes by itself is unreachable (`plan.offZone`),
  `plan.zones` / `plan.zonesEmpty` report each zone.
- **The eraser**: `excluded` tip ids are left out ("don't support here", not
  counted unsupported); an excluded branch / trunk is found by id in the plan,
  becomes a keep-out (its polyline swept, 5 mm short of a tip it held) and the
  plan is made again. `plan.excluded` = `{ members, tips, notErased, unknown }`.
- **Members**: `{ id, kind: tip|branch|trunk|pad|sheet, from, to, carries }`,
  carries transitive (owner's answer): a held tip is in exactly one trunk's
  carries, every other tip in `unsupported`. A stair's own trunks are trunk
  members; each tip a stair holds is carried by the nearest of them. Ids hash what a member carries and
  where it runs, so they repeat across builds of the same inputs.
- **Owner's answers this ticket asked for**: carries transitive (one trunk per
  tip); an erased member is a keep-out; landing in a zone means the trunk's centre
  is inside the circle (changed from the end's footprint after the rebase onto
  #274's flared feet).
