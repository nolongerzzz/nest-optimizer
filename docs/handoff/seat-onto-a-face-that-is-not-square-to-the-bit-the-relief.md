## Seat onto a face that is not square to the bit - the relief measure was reading the angle (2026-09-20)
`app-join.js` `NSO_seatTipsProbe` (how `rise` is measured), plus a residual
floor on gap mode (`NSO_SEAT_GAP_RESIDUAL_LIMIT`, `NSO_seatResidualReason`).
Check: `npm run seat:tilted` (`tools/nso_seat_tilted_face_test.js`, in
`npm test`).

**The report.** "Seat (support), box to box, leaves the piece elevated in
mid-air rather than positioned relative to the join. The same wrong placement
happens box to bordered-washer."

**Reproduced** at the two simplest library pieces through the real library
browser - `box_hull_80x40x20.stl` as the target, `box_bit_12x8x8.stl` as the
bit, dragged over it on the bed, Seat (support) at the slider default - with
**one extra step: a single press of the Tilt arrow**, on either piece. The bit
is left parallel to the plate, hanging off the high edge of the slope and
touching nothing, while the status line reads
`Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm) - from skin
tips, relief 1.07mm above the base plane`. The true shell-to-shell distance
(`tools/nso_soup_distance.js`, which the status line cannot fake) is
**0.1739 mm** at one press and **0.1559 mm** at two, against the 0.18 asked
for.

**Not the corner-ray / outward tie-break issue** fixed in `404b996`, and not
from any of that night's placement merges: the same case measures identically
at `060b685`, the commit immediately before that fix. It came in with the
skin-tips reference (2026-09-16); `app-join.js` at `2a6d07a` (2026-09-15)
carries no tips probe at all.

**The cause.** `NSO_seatTipsProbe` decides whether the surface under the bit is
a contact skin, and `NSO_seatFlushBitToHull` sends gap mode down one of two
completely different paths on that answer: over `NSO_SEAT_TIPS_TOL` (0.01 mm)
the bit is set against the tips **untilted**, under it the corner-ray fit runs
and **tilts the bit onto the face**. The probe measured the relief as

    ext.s - mean(hit . n)

an extreme height against an AVERAGE height, both along the BIT's own normal.
Those two agree only while the face is square to that normal. Tilt either piece
and the four corner-ray hits sit at four different heights along `n`, their mean
lands at the middle of the face, and the highest point of that same FLAT face
stands above the mean by half the face's rise across the footprint: **1.07 mm at
15 degrees, 2.31 mm at 30, 4.00 mm at 45**, on a plain flat box top. Every one
of those is a hundred times the tolerance, so a flat face was called a contact
skin and the tilt fit was skipped.

And it could not be caught from the status line: the tips path measures its own
residuals against the very extreme it positioned from, so it reported
`skin error 0.00mm` on a seat that was 0.006 mm out and, with the bit itself
tilted 45 degrees, `skin error 8.00mm` and `measured -4.180mm` under the word
"Seated". The same class of defect the read-back fix in `404b996` removed from
the plane path.

**Fix.** Measure the relief against the **plane of the four hits** - the plane
the fit itself tilts onto, `NSO_newellNormal` of the hit quad - instead of the
mean of their heights:

    rise = (extreme point - centroid of the hits) . nFit

A flat face at any angle puts its own extreme point in that plane, so the rise
is Float32 noise and the corner-ray path runs, byte for byte as it did before
the tips reference existed. A real relief still stands its tip height proud of
the plane its rays found, so the skin case is untouched - `skin:drive` still
pins `from skin tips, relief 0.60mm`, and `seat:curved-audit` still reads a
bare sphere as a 3.11 mm relief. A degenerate hit quad, or one so edge-on to the
bit's normal that the projection means nothing, keeps the old mean.

**Second change, from measuring the first.** Three presses of Tilt (45 degrees)
is past where the corner-ray fit converges: the bit slides past the target's
uppermost edge part way through and the fit oscillates (4.75 mm off the 0.18 at
the shipped three iterations, 0.06 at six, 2.37 at ten). Before, that reported a
clean seat 0.053 mm out; on the plane path it would now report `skin error
4.74mm` and still say "Seated". So **gap mode refuses when its own read-back is
further off than the gap slider's whole range** (0.25 mm,
`NSO_SEAT_GAP_RESIDUAL_LIMIT`), restores the pose and names both numbers. Gap
mode only: `proud` mode's residual on a curve is a measured, deliberately-pinned
limitation (`docs/SEAT-SURFACE.md` finding (c), `seat:curved-audit` section 3),
not a failure to place. Every seat the suites pin measures 0.00.

**The washers, measured** (`npm run seat:tilted` does not cover these; the
numbers are from the same drive, true distances via `nso_soup_distance.js`):

| target | bit | result | true distance |
|---|---|---|---|
| loose washer (skin patch, 30x30) | box bit, stacked | Seated | **0.1800** |
| bordered washer | box bit, stacked | Seated | **0.1800** |
| sandwich patch | box bit, stacked | Seated | **0.1800** |
| box hull | any of the three, stacked | Seated | **0.1800** |
| any washer | box bit, **side by side** | refuses, `corner 1 missed hull along punch axis` | - |
| 12x8 box | 30x30 washer, stacked | refuses, `corner 0 missed hull along punch axis` | - |
| 30x30 washer | 80x40 box, stacked | refuses, `corner 0 missed hull along punch axis` | - |

So **loose-washer seating works and always did** - it is exact in every
direction where the bit's footprint sits over the target, before this fix as
well as after. The two refusals are the corner-ray fit's own stated contract
(all four corner rays must land, and it returns on the first that does not),
and both are the thin-flat-geometry limitation already on record, not this
bug: an 8 mm bit seated against a 0.6 mm washer edge has two of its four rays
leaving above the top of that edge, and a 30x30 bit over a 12x8 target has no
target under its corners at all. Both refuse **without moving anything**.

**One thing the bordered washer does that reads as a wrong placement and is
not.** A 12x8 bit centred on a 30x30 bordered washer lands with its underside
at 1.58 while the washer's rim top is at 2.00 - 0.42 mm *below* what a user
sees as the top of the washer. The true distance is exactly 0.18: the bit is
seated on the crosshatch inside the rim, because the rim is not under its
footprint. That is the footprint rule, `docs/SEAT-SURFACE.md` finding (d),
and a bit wide enough to cover the rim seats on the rim instead. Unchanged by
this fix in either direction.

### Known, unfixed, measured here
- **45 degrees and past** the corner-ray fit does not converge on a tilted flat
  face. It now refuses rather than reporting a seat it did not make. Making it
  converge means reordering rotate-and-translate inside the fit, which moves
  every pinned curved-seat pose; not this ticket's.
- **A free rotation does not survive a pose button.** `applyMeshRotation`
  rebuilds the mesh's rotation from the placed record's fields (`rotY`, `tipX`,
  `tiltX`, `tipZ`, `tiltZ`), which carry no free rotation, so one press of
  Raise or Lower on a piece the seat laid on a slope throws that angle away -
  and `snapshotPlacedPose` carries the same fields, so **Undo cannot put it
  back**. Pre-existing, the same gap `seat:curved-audit` section 6 pins on the
  export side, and pinned now on the pose side in
  `tools/nso_bring_to_plate_test.js` section 4.

**`?v=` NOT bumped** - rule 4, Grok owns those. `app-join.js` still ships at
`?v=libsave1`, `app-core.js` at `?v=integ1`, `app-poslock.js` at `?v=lock1`.
