## Triple join - A-B-C in one press, two junctions, two gaps (2026-09-20)
`app-join-triple.js` behind **Join A-B-C** in the Join card, with a third slot
beside A and B, a vertical/horizontal mode select and one gap input per
junction. Check: `npm run join:triple`
(`tools/nso_join_triple_test.js`, in `npm test`).

A three-piece stack was already possible by hand - pick A and B, Center lock,
Seat (support), then re-pick B and C and do it again - and two things went
wrong every time. The re-pick is easy to get backwards, because "C onto B" is
not "B onto C" and the slots do not say which way round the last press left
them. And there is one gap slider, so the second seam silently inherited
whatever the first seam was set to: a coupon with a real 0.18 mm release gap at
one seam and a solid weld at the other could not be built in one pass at all.

This adds no positioning math. Each junction is Center lock followed by Seat
(support), called exactly as their own buttons call them; all the sequence
decides is the order and which gap goes with which seam. The two load-bearing
gates in the check are the ones that say so: the pose the triple leaves B in is
bit-for-bit the pose `Center lock` + `Seat (support)` leave B in by hand
(vertical), and `Center Z` + `Seat (support)` leave B in by hand (horizontal) -
same `mesh.position`, same quaternion, same `x`/`z`/`liftY`, compared with `===`
rather than a tolerance.

The two modes differ in one step: which rough placement runs before the seat.
**Vertical stack** is Center lock as its button runs it - the mover's reference
point onto the host's, in X and Z - so the mover lands over the host,
`NSO_raiseBuriedBitClear` lifts it clear of the host's top and the seat punches
down. **Horizontal sequence** takes the same Center lock reference points (its
exported `refPointXZ`, honouring the same bbox/centroid selector) and applies
the delta on the CROSS axis only, leaving the axis the two are separated along
alone, so they stay side by side and the seat punches sideways. Which axis that
is, is the question Center X / Center Z already answer (`centerJoinAxis`'s
`punchIsX`): the run axis is the one with the larger separation, and centring on
it is what would pull the mover into the host. The seat still chooses its own
punch axis from the pose it is handed; the mode chooses the pose, it does not
overrule the seat.

Chaining is safe by construction, and the check pins it rather than arguing it.
The second junction seats C onto B, and `seatBitAtGap` starts by calling
`settlePlacedOnBed` on its host - B, which is at that moment floating on top of
A. B does not fall: the seat that put it there wrote `liftY = boxBottom - 0.2`,
and `settlePlacedOnBed` puts the box bottom back on `0.2 + liftY`, so the settle
is a no-op on a seated piece and the first seam survives the second untouched.

Three small additions outside the new file, all of them additive:
`seatBitAtGap` now RETURNS what it did (`{ ok, gap, measured, residual,
reference, clamped }`, or `{ ok: false, reason }`), because a caller that chains
seats has to know whether to run the next one and scraping the status line for
that would make the wording load-bearing - a clamped seat counts as a failure,
since the whole point of a per-junction gap is that the junction is at it.
`readSeatGapInput(id)` and `updateSeatGapReadout(id, outId)` take an input id
and default to the card's own slider, so the two junction gaps go through the
same reader rather than a copy of its rules. And `NSO_CenterLock.lastError()`
reports why the last refusal was a refusal, so the sequence can say which seam
stopped and why.

Known and deliberate: **a weld is an intersection.** At a positive gap the two
shells really do penetrate, and `tools/mesh_validate.py` reports piercing pairs
for that seam - the check asserts that it does, as the proof the weld is solid,
and exports a second, all-air-gap row to demand `verdict: PASS` with 0 piercing
and 0 coplanar pairs. Also deliberate: **Seat's limits are still Seat's
limits.** A piece whose footprint does not lie within its host's is not raised
clear and the corner-ray fit may refuse it, so a vertical stack wants each piece
no wider than the one under it. The sequence surfaces that refusal, names the
seam it stopped at and says the earlier seam is seated and was left alone,
rather than papering over it. Undo is four entries - lock, seat, lock, seat -
the same four the two junctions leave by hand, and backing all four out puts
every piece back.
