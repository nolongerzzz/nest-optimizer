# Triple join — A-B-C in one press

Three pieces, two junctions, one press. Each junction is **Center lock**
followed by **Seat (support)**, and each junction carries **its own gap**.

It is a sequencing tool. There is no positioning math in it: every millimetre
it moves is moved by Center lock and Seat, called exactly as their own buttons
call them.

## Why

A three-piece stack was already possible by hand — pick A and B, Center lock,
Seat, then re-pick B and C and do it again — and two things went wrong every
time.

1. **The re-pick is easy to get backwards.** "C onto B" is not "B onto C", and
   the slots do not say which way round the last press left them.
2. **There is one gap slider.** The second seam silently inherited whatever the
   first seam was set to. A coupon with a real 0.18 mm release gap at one seam
   and a solid weld at the other could not be built in one pass at all: set the
   slider, seat, move the slider, re-pick, seat again, and hope.

So: three slots, two gaps, one press.

## Using it

In the Join card, with a Join started:

- **Pick A, B, C** — the three slots, in the order the sequence runs. A is the
  piece everything else comes to; B is seated onto A, then C is seated onto B.
  The three must be different pieces; a click that would put the same piece in
  two slots is refused and the slot stays armed.
- **Mode** — *vertical stack* or *horizontal sequence* (below).
- **A-B** and **B-C** — one gap per junction. Same range, step and meaning as
  the Seat (support) slider: **-0.25 mm** (air) through **0** (touching) to
  **+0.05 mm** (overlap — a solid, welded penetration). The two are
  independent; mixing a real test gap at one seam with a weld at the other is
  the case this was built for.
- **Join A-B-C** — runs both junctions. Live only when all three slots are
  filled with different pieces.

The status line names both seams and what each one measured:

```
Joined A-B-C stacked - A-B air gap 0.18mm (measured -0.180mm), B-C overlap 0.05mm (measured 0.050mm)
```

## The two modes

The modes differ in **one step**: which rough placement runs before the seat.
The seat then chooses its own punch axis from the pose it is handed, exactly as
it always has. The mode chooses the pose; it does not overrule the seat.

| | rough placement | what the seat then does |
|---|---|---|
| **Vertical stack** | **Center lock**, exactly as its button runs it — the mover's reference point onto the host's, in X *and* Z | the mover lands over the host, `NSO_raiseBuriedBitClear` lifts it clear of the host's top, and the seat punches **down** |
| **Horizontal sequence** | the same Center lock reference points (its exported `refPointXZ`, honouring the same bounding-box / centroid selector), with the delta applied on the **cross axis only** | the two stay side by side and the seat punches **sideways** |

In horizontal mode the axis the two pieces are separated along is left alone.
Which axis that is, is the same question **Center X / Center Z** already answer
(`centerJoinAxis`'s `punchIsX`): the run axis is the one with the larger
separation, and centring *on* it is what would pull the mover into the host.

Vertical mode honours a **Pick target** point on A at the first junction, the
same way pressing Center lock by hand does. The stored target belongs to the
piece in slot A, so at the second junction — where the host is B — it does not
apply and B's own centre is used.

## What holds, and what does not

- **Chaining is safe by construction.** The second junction seats C onto B, and
  `seatBitAtGap` starts by settling its host — B, which is at that moment
  floating on top of A. B does not fall: the seat that put it there wrote
  `liftY = boxBottom - 0.2`, and `settlePlacedOnBed` puts the box bottom back
  on `0.2 + liftY`. The settle is idempotent on a seated piece, so the first
  seam survives the second untouched.
- **Undo is four entries** — lock, seat, lock, seat — the same four a
  hand-run pair of junctions leaves. Nothing is collapsed.
- **A junction that cannot seat stops the sequence** and says which seam
  stopped it, and whether the earlier seam is seated and was left alone.
- **Seat's own limits are still Seat's limits.** A piece whose footprint does
  not lie within its host's is not raised clear, and the corner-ray fit may
  refuse it — a vertical stack wants each piece no wider than the one under it.
  That is pre-existing Seat behaviour; the sequence surfaces the refusal rather
  than papering over it.
- **A weld is an intersection.** At a positive gap the two shells really do
  penetrate, and the canonical checker reports piercing pairs for that seam.
  That is the feature. An all-air-gap triple join exports with
  `verdict: PASS`, 0 piercing and 0 coplanar pairs.

## Where it lives

| | |
|---|---|
| `app-join-triple.js` | the sequence, the modes, the two gaps, the UI |
| `app-join.js` | slot C in `updateJoinUI` / `assignJoinClick`; `seatBitAtGap` returns its result; `readSeatGapInput(id)` / `updateSeatGapReadout(id, outId)` take an input id |
| `app-center-lock.js` | `NSO_CenterLock.lastError()` — why the last refusal was a refusal |
| `app-core.js` | `state.joinThirdId` / `state.joinFaceC`, cleared wherever the pair is retired |
| `index.html`, `styles.css` | the C slot, the mode select, the two gap rows |
| `tools/nso_join_triple_test.js` | the drive check (`npm run join:triple`) |

The two load-bearing gates in the drive check are the ones that compare the
sequence against the buttons it is made of: the pose the triple leaves B in is
**bit-for-bit** the pose `Center lock` + `Seat (support)` leave B in by hand
(vertical), and `Center Z` + `Seat (support)` leave B in by hand (horizontal).
