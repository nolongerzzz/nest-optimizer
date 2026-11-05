## Seat refuses a bit the target face cuts through (2026-09-17)
`app-join.js` `NSO_seatStraddle` / `NSO_SEAT_STRADDLE_TOL` and one gate inside
`NSO_seatFlushBitToHull`. Check: `npm run seat:overhang`
(`tools/nso_seat_overhang_test.js`, in `npm test`, 44 gates). Found beside the
local-carve audit, not reported from the bed: a bit sitting ACROSS a hull wall
seats "successfully", and the seat eats every millimetre that stood proud.

**The defect, measured.** Hull `box_hull_80x40x20-2` (80 x 40, 20 tall),
bit `hinge_knuckle_box` (18 x 8 x 8), the bit put across the hull's +X wall at
mid-height: 6 mm of it proud of `x = 40`, the other 12 mm already inside the
hull. Seat flush returns `Seated - proud 0.01mm, skin error 0.00mm - Subtract`
and leaves the bit at `x 22.01 .. 40.01` - the 6 mm driven to 0.01 mm and the
whole bit buried as a plug through that face, with no warning anywhere. Seat
(support) at -0.18 takes the same pose and teleports the bit 12 mm the other
way, out of the hull, and also says `Seated`.

Why it was reachable and why it survived every earlier suite: the fit refuses
as soon as a corner ray misses (`corner N missed hull along punch axis`), and
over the hull's TOP face a straddling bit always has a corner in the air, or
else its footprint is inside the hull's and `NSO_raiseBuriedBitClear` lifts it
clear first. A vertical WALL is different - it can shadow all four corner rays
at once, and nothing raises a bit sideways. The same bit 7 mm higher (2 of 4
rays miss) and at the vertical edge (1 of 4) refuse exactly as they always
did, so the shipped behaviour flipped between "refuse" and "swallow the bit"
across a 7 mm move. Neither the Seat-gap nor the Seat-align fixture pair can
reach the pose at all: a 20 mm cube against a 20 mm wall always has two
corners off the wall, which is why both suites pass on the defect.

**Fix.** `NSO_seatStraddle` (pure; the seat calls it once, on the pose it was
given, before the tips probe and the fit). It casts the fit's own four corner
rays and compares each hit with the bit's depth along the punch axis: `d >=
depth` everywhere means the bit is clear of the face and approaches it (the
staged plug, the raised bit, the side seat); `d <= 0` everywhere means it is
wholly inside (a plug being re-seated). In between, the face cuts through the
bit, and the seat refuses with the millimetres at stake:
`Seat failed - bit straddles that hull face - 6.00mm of it stands proud and
the rest is already inside. Move it clear of the face (or fully inside) and
seat again`. Nothing is moved - both buttons already restore the bit on a
refused seat, and the plate export is byte-identical across the click.
`NSO_SEAT_STRADDLE_TOL` is 0.1 mm, so the 0.01 mm a flush seat leaves standing
proud and the 0.05 mm the gap slider's overlap end pushes in are the seat's own
handiwork, not an overhang: seating twice in a row still lands `===`.

**Validation** (`tools/nso_seat_overhang_test.js`, real buttons and the
canonical checker). The reported case refused by both buttons, the bit's
position / quaternion / x / z / liftY and the exported plate STL identical
across the click, and the same placement with the guard stubbed out still
producing the shipped 6 mm -> 0.01 mm burial, so the gate cannot pass
vacuously. A 504-placement sweep - four walls x seven heights x nine depths,
both modes - with 185 seats, 176 straddle refusals and 143 missed-corner
refusals: no placement seats while the face cuts through the bit, every
refusal restores the pose exactly, and the probe moves nothing. Untouched:
the Seat-gap golden flush pose and status to 1e-9, a flush seat repeated,
the side plug (a bit clear of the wall driven in to 0.01 proud), the buried
plug pulled back out, the locked -0.18 easy-release seat with its export
through `tools/mesh_validate.py --json` (watertight, 0 piercing, 0 coplanar,
two shells 0.18 mm apart), +0.05 and 0 re-seated from their own results, and a
-0.18 gap seat against a wall. `npm run seat:gap` and `npm run seat:align`
unchanged, and `npm test` green. (When this landed, the four steps that launch
Playwright's own default browser build - `cth-test/capture-check.mjs`,
`cth-test/drive-check.mjs` and the two `3mf-test` drive checks - could only run
here with a hand-installed Playwright that matched the sandbox's Chromium. The
devDependency is pinned to that version now, so a clean `npm install` runs all
of them; see the 3MF checks section.)

**Known limits, stated not solved.**
- A bit that straddles is refused, not rescued. The vertical case has
  `NSO_raiseBuriedBitClear` to lift a buried bit clear and seat it from above;
  there is no sideways equivalent, and inventing one would move a piece in XZ,
  which is the user's own placement. The message says which way to move it.
- Clicking Seat flush a second time on a SIDE plug refuses with `corner 0
  missed hull along punch axis`, with this guard and without it:
  `NSO_raiseBuriedBitClear` counts the seated plug as buried (its footprint is
  inside the hull's to the 0.05 mm pad its 0.01-proud face now sits within),
  lifts it above the hull's TOP, and the corner just past the top face's edge
  misses. Older than this work, untouched by it, and pinned at the core where
  the re-seat does hold.
- The straddle gate reads the bit's box corners, like the fit it guards. A bit
  whose silhouette is much smaller than its box can have all four corner rays
  clear of the hull while the body is not; that is the fit's own assumption,
  not something this gate narrows.
