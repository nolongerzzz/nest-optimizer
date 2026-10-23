## Seating side by side - the corner rays are inset (2026-09-17)
`app-join.js` `NSO_SEAT_RAY_INSET` / `NSO_seatRayOrigins` (every corner ray in
the seat now leaves from those origins), and `NSO_SEAT_BED_EPS` in
`seatBitAtGap`'s lift clamp. Check: `npm run seat:side`
(`tools/nso_seat_side_test.js`, in `npm test`, 72 gates). This closes the
limit the vertical-stacking work stated and did not solve: "Two pieces resting
side by side on the bed never seat horizontally - `Seat failed - corner 0
missed hull along punch axis`."

**Audit first (Task 1), and the reading it confirmed.** The limit's own
diagnosis held up against the code, and the numbers are these. Hull
`box_hull_80x40x20-2` settled on the bed (`0.2 .. 20.2`), `box-20mm` dragged
beside it 3 mm off the `+X` wall: the plug frame picks `+X`, and the four rays
leave the bit's `+X` face corners along `-X`. The two at `y = 20.2` hit the
wall at `x = 40`, `d = 23`. The two at the bit's bottom do not. Both bottoms
are on the bed baseline by construction - `settlePlacedOnBed` puts every
world-box bottom on `0.2 + liftY` - so those rays travel *along* the hull's
bottom edge, where `NSO_rayTri` needs a strictly interior barycentric hit and
the graze measures ~1e-9 of the wrong sign. The fit refuses on the first one.

Swept through the real app: 60 side-by-side placements (four walls x five
distances from the wall, `0 / 0.18 / 1 / 3 / 10` mm, x three slides along it).
**All 60 lose at least one corner ray with the origin at the corner**, at an
inset of 1e-9 too. At 1e-7 and above, 50 of them recover all four; the other
10 are the slides that hang 3 mm past the hull's own `+Z` edge, and they keep
missing at every inset out to 0.01 mm - a bit that overhangs the target face
must still refuse, and it does. No recovered ray reports the far side of the
hull: every one measures the near wall, `d = 20 + the staged distance`, exact
to 1e-6.

*The sweep is a gate now, not an audit number (2026-09-18).* It first landed as
a measurement quoted here and nowhere else, which left the inset's value
resting on a number no check could reproduce. It is section 10 of
`tools/nso_seat_side_test.js` - 20 of that suite's gates - staged through the
app's own `settlePlacedOnBed` / `nudgeSelected` path so the bed baseline is the
one the seat sees, and run as corner-ray arithmetic over the 60 poses rather
than 60 clicks, so it costs one page round trip instead of a minute. It pins
every number in the paragraph above: 60 placements, the 10 that overhang
derived from the geometry rather than hardcoded, all 60 losing a ray at inset 0
and at 1e-9, 50 recovering and those same 10 still refusing at each of 1e-7 /
1e-5 / 0.001 / 0.01, every recovered ray measuring the near wall, and 0
straddle flags throughout. Load-bearing, checked the way section 2 checks the
fix: with the inset taken back out of `NSO_seatRayOrigins`, four of the gates
fail.

**False-positive straddle - the thing to get wrong.** The overhang gate
(`NSO_seatStraddle`, "Seat refuses a bit the target face cuts through") reads
the same four rays and skips itself entirely when one misses (`if (!h) return
null`). So the rays could not be fixed in the fit alone: the fit would seat a
bed-level straddle the gate had just been blinded to. Both read the inset
origins now, and per the gate's own arithmetic a side-by-side pose can never
read as a straddle - a corner cut needs `off + 0.1 < d < depth - 0.1`, and a
bit that stands clear of the wall has `d = depth + its distance from it`.
Measured, not just argued: 0 straddle flags across all 60 placements at every
inset from 0 to 0.01 mm, and the overhang suite's own 504-placement sweep
returns the same counts as before this change - 185 seated, 176 straddle
refusals, 143 missed-corner refusals. What did change is the bed-level
straddle the gate used to lose: 6 mm of the bit proud of the `+X` wall on the
bed now refuses by name instead of by missed corner.

**Fix.**
- `NSO_seatRayOrigins(corners)` pulls each ray origin `NSO_SEAT_RAY_INSET`
  (0.001 mm) along the face's own diagonal toward the face centre - a fraction
  of the way, never a fixed step, so a sub-millimetre bit still samples inside
  its own face. The offset is in the face plane, which is perpendicular to the
  punch axis, so every measured `d` is unchanged: pinned at 1e-12. One micron
  is ~100x the Float32 vertex noise a plate-sized coordinate carries and 1/100
  of `NSO_SEAT_STRADDLE_TOL`, 1/10 of the gap slider's step - no offset the
  seat can express sees a different point. Used by all five corner-ray sites:
  the fit loop, `NSO_seatStraddle`, `NSO_seatTipsProbe`, the residual report,
  and the `Flush` readout.
- `NSO_SEAT_BED_EPS` (1e-6) in `seatBitAtGap`. A horizontal seat never changes
  the bit's height, so a settled bit comes back with `liftY = -1e-16` and the
  old `if (lift < 0)` appended "bit would sink below the plate, held at plate
  level: gap NOT as requested" to a seat that had done exactly what was asked.
  The clamp to 0 stays; only the warning now needs a real sink.

**Validation** (`tools/nso_seat_side_test.js`, real buttons and the canonical
checker). The staging is asserted to be the grazing one (both world-box
bottoms `===`). With `NSO_seatRayOrigins` stubbed back to the bare corners the
same click reproduces `Seat failed - corner 0 missed hull along punch axis`
and moves nothing, so the gates cannot pass vacuously. Seat (support) at
-0.18: `Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)`,
mating face 0.18 off the wall, the bit still on the bed (bottom `===` the
hull's, `liftY` 0), Z, mesh y and the quaternion untouched, one undo entry,
re-seat and Undo both `===`. The export through `tools/mesh_validate.py
--json`: 40 triangles, 0 open, 0 non-manifold, volume 71360.000 (hull + bit),
0 piercing, 0 coplanar, width 100.18, height 20, two shells 0.1800003 apart
along X, both on z = 0. -0.05 and 0 through the slider with their own export
signatures (0 gives coplanar contact, as it does stacking). All four walls
seat, each moving the bit along that axis only. Seat flush side by side gives
the side plug, outer face 0.01 proud. A 6 mm bed-level straddle is refused by
both buttons with the pose and the plate export identical across the click.
The clamp: a stubbed 1e-9 drop seats clean, a stubbed 1 mm drop still warns.
`npm run seat:gap`, `npm run seat:align` and `npm run seat:overhang` are
unchanged, golden poses and counts included.

**Known limits, stated not solved.**
- A bit that overhangs the target face still refuses on the overhanging
  corner. The inset is a micron; it rescues a graze, never a real overhang,
  and the sweep pins that at 10 placements out to a 0.01 mm inset.
- The seat still samples the hull at four points. A hull feature between them
  is invisible to the fit, inset or not - that is the corner-ray fit's own
  assumption, unchanged here.
- Gap 0 side by side exports coplanar contact, exactly as gap 0 does when
  stacking: two shells touching, which the canonical checker counts.
