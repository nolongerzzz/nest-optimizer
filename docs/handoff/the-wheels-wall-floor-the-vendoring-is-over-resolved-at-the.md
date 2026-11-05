## The wheel's wall floor - the vendoring is over, resolved at the merge
The Pottery Wheel branch carried a VENDORED copy of `nso_thickness.js` (from
`claude/wall-thickness-nozzle-safety-axpwtt` at `a017e12`), because the wall
floor had to be the canonical one and that branch was not merged at the time.

**Both have now landed on `claude-wip`, and the vendoring is resolved.** The
wall-thickness branch's own version won the add/add conflict, deliberately: it
is `80caaa6`, a strict superset of what the wheel vendored - same `floorFor`,
same `measureLoop` (checked call-for-call, identical output on a meridian),
plus `cutClearance()` / `cutWarning()`, which the older copy did not have. The
wheel's copy would have been a silent regression.

So there is now ONE `nso_thickness.js` and one `docs/WALL-THICKNESS.md`, and
`tools/nso_wall_thickness_test.js` - which the wheel branch could not carry,
since most of it A/Bs the retrofit of `app-cut.js` / `app-finish.js` - is in
`npm test` alongside `npm run wheel`. Nothing is duplicated and nothing is
pinned to an old revision.

What the wheel adds on top is unchanged by any of that: it takes its floor
from `NSO_Thickness.floorFor()` and carries no literal, and it deliberately
does NOT use `measureLoop` as its live gate - see finding 5 in
`docs/POTTERY-WHEEL.md` for the 1.47 mm the ray pass loses on a meridian.
