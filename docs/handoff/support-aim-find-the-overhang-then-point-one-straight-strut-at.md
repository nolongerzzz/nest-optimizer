## Support aim - find the overhang, then point one straight strut at it (2026-09-19)
`nso_support_aim.js`, loaded at `?v=support1` straight after `nso_thickness.js`
(it reads the floor from it). **Not wired to any button** - module, suite and
docs first, the UI entry point as its own change, same shape as `NSO_Repair`
when it landed. Full write-up: `docs/SUPPORT-AIM.md`.

Two halves: `detectOverhangs` finds downward-facing surface steeper than the
printable angle **with nothing underneath it**, and `aim` / `plan` point one
straight strut from the nearest viable base at such a region and grow it to
touch. `npm run support:test` (82 checks, headless) and
`npm run support:canonical` (37 checks, `tools/mesh_validate.py`, machine-
compared). Both in `npm test`.

Reuses, unmodified: `NSO_extendRaw` for all the growing, `NSO_Thickness.floorFor`
for the only wall floor, `NSO_SeatSurface.quatFromTo` / `transformSoup` for the
turn and the bake.

Five things a later ticket should read before touching this:
- **The viewport tint is not a detector and must not be reused as one.**
  `applyOverhangColors` (`app-core.js`) flags `n.z < cos(45)` - every face more
  than 45 deg off UP, a vertical wall at `n.z = 0` included - then patches the
  flat underside back out with a second `n.z > -0.95` clause. Measured on the
  cantilever fixture: 20 of 24 faces tinted, 2 genuinely unsupported. The
  correct test is `n.z < -cos(angle)`. The angle-vs-normal shape was borrowed;
  the threshold is corrected.
- **Half the detector is the downward ray, not the angle.** A steep downward
  face with material under it is already supported. The suite pins this on two
  shapes a tint cannot tell apart - a cantilever arm, and the same arm with a
  pillar under half of it - where the unsupported area goes 200 -> 100 mm^2.
  The ray's window runs all the way TO the plate: a pillar standing flush under
  the overhang starts the ray inside itself, and a window stopping a hair short
  calls a fully propped overhang unsupported. That cost two test failures
  before it was found.
- **Build, grow, THEN turn.** Extend refuses an off-cardinal axis by name, so
  the strut is grown in its own local +Z with the axis forced and only then
  aimed. Turn first and there is no axis left for Extend's bit-for-bit promise
  to be about. A later ticket must not "simplify" this into orienting first.
- **A free orientation is baked, not posed - the third time this has been
  found.** Local-Carve found it for the blade and Seat-Against-Curved for the
  seated piece: `buildCombinedGeometry` rebuilds rotation from the quantised
  pose fields and never reads `mesh.quaternion`, so a posed rotation is visible
  in the scene and absent from the export. `place()` bakes the turn into the
  strut's triangles and returns the matrix as data. It is also what lets the
  result go through the canonical checker as it stands.
- **The flat cap is not shaped to the contact, and the cost is measured.** On
  an oblique aim the cap corner stands `(side/2) * sin(tilt)` past the target
  face - 0.189737 mm for a 1.2 mm strut at 18.435 deg, pinned against that
  closed form. Reported as `tipPenetrationMm`. Contact geometry is deferred
  here exactly as `nso_seat_surface.js` deferred it; the two should be solved
  once, for both.

**Out of scope, named for the next ticket: curving / branching organic paths**
(multi-segment, spline-routed tree supports like Bambu's). This is
straight-line-to-nearest-base only, and a blocked line is refused rather than
routed around. The finding worth carrying forward is that branching needs a
different GROWTH mechanism as well as a different path search - Extend refuses
a curved axis by name - so the two belong in one ticket, not two.

**Half of that landed in the same merge**: `nso_path_sweep.js` (see "Curving
paths" above) is the growth mechanism, built on Extend's argument carried round
a corner. The branching ticket therefore needs the PATH SEARCH and the
attachment, not a sweep - it should call `NSO_PathSweep`. Both modules are
parked unwired; that is the right order. The two were written on branches that
could not see each other and do not overlap: no shared file beyond
`index.html`, `package.json` and this document, and neither touches
`app-extend.js`, `nso_thickness.js` or `app-core.js`.

Also not here: support density / layout (one region, one strut) and bridging
(a ceiling with nothing under it is flagged; whether the slicer could bridge it
is a judgement no angle test can make - `region.spanMm` is reported, no view
taken).

PAINT SCOPE: **sub-region**, per the scoping rule above. The feature names
specific faces, so the check is scoped to the faces it flags and paint
elsewhere does not stand it down. `opts.skipList` is REQUIRED - omitting it is
refused by name rather than defaulted to unpainted, and a `null` from
`nsoMaskFaceList` is refused too.
