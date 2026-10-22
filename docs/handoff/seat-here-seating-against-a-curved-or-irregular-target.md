## Seat here - seating against a curved or irregular target (2026-09-18)
`nso_seat_surface.js` (new: the pure core, browser + Node),
`app-seat-surface.js` (new: the **Seat here** button, an armed click in the
Join card), `tools/nso_soup_distance.js` (new: the independent
minimum-distance checker), plus small additive changes to `app-core.js` (the
undo label, `prevPose` on the replace-undo branch, the click question),
`app-measure.js` and `app-carve.js` (disarm each other), `index.html`,
`styles.css`. Full write-up: `docs/SEAT-SURFACE.md`.

Checks: `npm run seat:curved-audit` (`tools/nso_seat_curved_audit.js`, Task
1's audit, exit 0 = every finding still holds), `npm run seat:surface`
(`tools/nso_seat_surface_test.js`, the gate), `npm run dist:selfcheck`. All
three in `npm test`. **This is the separate ticket the Texture section above
dispatched, and it answers the open question that note left open - what
`supportExtreme` and Seat mean against a curved contact. Of the two options it
offered, this is the second: Seat grew a second mode.** It is a new module and
a new button, so Texture's own gate ("neither new file calls supportExtreme,
tipContactArea or any Seat entry point") still holds, `nso_skin_band.js` and
`app-texture.js` are untouched, and a Texture band is still not offered as a
Seat target - this seat measures an interface between two pieces, and the
relief's tip surface is not one.

**Positioning only.** The SHAPE of the contact - a mating face cut to the
curve, a pad, a cup - is a separate later layer, and the boundary is measured
rather than waved at: see `docs/SEAT-SURFACE.md`, "Deferred: contact
geometry".

**Audit first, and the answer was BOTH.** The shipped seat casts four rays
from the corners of the bit's outer box face along one axis. A curved target
falls away from a flat footprint, so those corners overhang and the ray misses
- a 20 mm bit over the 20 mm sphere, a 12x8x8 bit 5 mm off the crown, anything
over the genus-1 groove and a 20 mm bit over the organic blob all refuse on
BOTH buttons with `corner N missed hull along punch axis`. Where the rays do
land, gap mode reaches the skin-tips branch and measures the right minimum -
but reports a bare sphere as `from skin tips, relief 3.11mm above the base
plane`, and writes a rotation of 0.0000 degrees, so the piece is never
oriented to the surface. `proud` mode has no tips probe at all: a rod on end
over the crown seats with a residual of 0.4754 mm against a requested 0.01.
And the footprint is the bit's BOX face, not its contact outline, so on the
blob a requested 0.18 mm air gap really measures 0.2053 (round rod: the square
over-reaches the circle) or 0.1737 (flat bit: the blob rises outside the
footprint) - both larger than the 0.05 mm easy-release window.

**The finding that decided the design.** `buildCombinedGeometry` rebuilds each
piece's rotation from the quantised pose fields and never reads
`mesh.quaternion`. Measured: a 0.3 rad tilt is 25.017 mm of scene height and
20.000 mm of exported height, every pose field still zero. So the shipped tilt
fit cannot be gated through the canonical checker at all - the file does not
carry what the screen shows. **Seat here therefore writes no free rotation.**
It rotates the piece's own raw soup by the delta in raw axes
(`Rx(+90) . Q_pose^-1 . delta . Q_pose . Rx(-90)`), commits through
`NSO_sculptCommitRaw` like every other bake, and re-fits x / z / liftY to the
world box the plan measured. That is Local-Carve's contained-pose-state
decision reached from the other side: the blade stays out of `state.placed`, a
seated piece cannot, so the pose model must never be handed anything it cannot
hold.

**What is reused, not rewritten.** `NSO_Carve.probeTarget` identifies the
feature at an arbitrary point (its dihedral merge is what reads a tessellated
dome as ONE face); `NSO_Skin.supportExtreme` measures a surface over a quad
footprint and is already orientation-agnostic; the gap sign convention and the
`#seat-gap` slider are the shipped ones - negative = air, positive =
penetration, 0 = touching.

**One thing probeTarget could not be used for.** Its outward direction is not
a tangent-accurate normal and cannot be: it buckets triangles within 5 degrees
and keeps the FIRST one's normal as the bucket's, so on a fine mesh the answer
depends on triangle order - up to 2.5 degrees off analytic on a 240x480
sphere, and no finer a mesh helps. Fine for a blade, not for a seat (2.5
degrees across a 12 mm footprint is 0.25 mm at the far edge). So the feature
comes from probeTarget and the NORMAL is measured next to it, as the true
area-weighted mean over the same neighbourhood: 0.0000-0.1825 degrees against
calculus, on a coarse mesh and a fine one alike.

**What "the gap" means, and it is solved not inferred.** `gap < 0`: the TRUE
MINIMUM DISTANCE between the two surfaces is `|gap|`. `gap = 0`: first
contact. `gap > 0`: `gap` mm past first contact. First contact is a separate,
bracketed solve because `dist(t) = 0` over a whole interval - inverting it as
if monotone is how a "touching" seat came out 0.14 mm clear and a "+0.05
overlap" 0.10 mm deep, both seen before the bracket went in. Where the contact
IS the footprint quad - every case the shipped seat was validated on - first
contact and the support plane are the same offset, so `gap` means exactly what
it meant before; where they differ, only the shape-dependent rule was ever
wrong. Measured payoff on the round rod over the blob, 16 aim points: the
support rule alone gives up to 0.6084 mm of real clearance for a requested
0.18; the solve gives 0.18000 at all sixteen.

**Two minimum-distance implementations, on purpose.** The core solves with its
own; the gates measure with `tools/nso_soup_distance.js`, stdlib-only with its
own self-check, and the suite asserts the two agree to 1e-9 on the real
fixtures. Same discipline as `tools/nso_selfint_equiv_test.js`. Both are exact
(9 edge/edge + 6 vertex/triangle, with contact tested separately), because
every Seat check before this one measured its gap as a box difference along one
axis - exact for two boxes, meaningless against a dome.

**Validation (real button, real curved fixtures, real export, canonical
checker).** Eleven aim points across the sphere (crown, equator, 45,
off-axis), the blob (top, side, off-axis) and the groove (ring top, outer
flank, dome at 45, and the CONCAVE inner wall), plus the flat block. Each:
scene clearance = the requested 0.18 to 2e-5; no free rotation on the mesh;
Export plate through `mesh_validate.py --json` with 0 open, 0 non-manifold, 0
piercing, 0 coplanar; and **the gap measured on the EXPORTED shells is 0.18 mm
to 5e-5**, 3MF the same - turns of 5.6, 23.4 and 44.5 degrees all coming out of
the file intact, which is the gate the shipped tilt fit could never pass. Euler
is asserted as the TARGET fixture's own plus the bit's 2, not a constant 4,
because `fixture_groove_concave` is genus 1. One Undo returns B to its imported
soup after every one of the eleven, so the bakes cannot stack. Plus the sign
convention through the button on the sphere's flank, ONE seat driven by a real
mouse click on the canvas, the paint stand-down and its converse, and four
app-level refusals.

**Regression: the flat-face seat is untouched.** `NSO_seatFlushBitToHull` is
byte-identical and `app-join.js` contains no reference to the new core - both
asserted. The golden flush pose (1e-9) and status line (byte for byte) and the
flat `-0.18` gap seat are re-pinned in the new suite as well as in
`tools/nso_seat_gap_test.js`, so a change to either has to fail two suites.
`seat:gap`, `seat:align`, `seat:overhang`, `seat:side` and `paint:scope` all
pass unchanged.

**Agreeing with the two threads that landed beside it.** Seat here writes the
seat record every Seat now leaves (`NSO_recordSeat`, app-join.js), so the 3MF
scene block carries its gap out to the file: `kind: 'support'`, `measured` in
the coupon sign, `reference: 'face'`, and no `residual` - there is no
corner-ray residual here and the normaliser reads a null as 0, so the key is
left absent. Gated on the piece AND through `buildPlateSceneJson`. And it
joins the one-armed-click-at-a-time rule both ways: arming it turns Center
lock's pick off, arming Center lock (or Paint, Carve, Measure) turns it off,
and `clearJoinSlots` retires it with the slot - silently, through
`nsoSeatHereDisarm`, because clicking the button there would print over the
caller's own status line. All gated.

**PAINT SCOPE: WHOLE-PIECE**, on the piece being seated, and only when the
seat has to turn it - the target is only ever read, and a seat that needs no
turn changes no geometry. A turn rewrites the whole soup in new axes, so no
sub-region survives as itself and whole-piece is the only coherent reading.
Reasoning in full: `docs/SEAT-SURFACE.md` §3.

**Known limits, stated not solved.**
- A flat face tangent to a sphere touches at ONE POINT and
  `mesh_validate.py` has no class for that, so a `gap 0` seat on a curve reads
  0 piercing / 0 coplanar exactly as an air gap does. The measured
  shell-to-shell distance (0.00000 vs 0.05000) and the piercing pairs at +0.05
  are what separate them, and the suite asserts both.
- The footprint is still the piece's box face. The solve makes that cost
  nothing in the SEPARATION; it still costs the contact-patch reporting, which
  is the deferred shape layer.
- A seat that would put the piece below the plate is refused rather than
  clamped. Clamping is what the gap seat does, and it is right there (the
  status says "gap NOT as requested"); here the whole point is that the gap is
  exact, so a pose that cannot deliver it is not offered.
