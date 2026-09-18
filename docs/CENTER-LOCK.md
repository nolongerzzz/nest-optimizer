# Center lock

A rough top-down placement step for the Join card, one stop ahead of Seat and
Align. It gets a piece "close enough" fast; Seat, Align and manual nudge still
do the fine work.

## What it is, and what it is not

| | matches | defined by | lives at |
|---|---|---|---|
| **Align edges** | edges | a flat wall on A facing B | the mating face |
| **Seat flush** | skins | B's outer face pushed onto A's surface | the mating face |
| **Center lock** | centres | one point on B over one point on A | neither piece's edges |

Align and Seat both need B to already be roughly where it belongs, and both are
defined by geometry *at the mating face*. Center lock is the step before either:
it ignores edges and skins entirely, takes one reference point on B and one
target point on A, and slides B in XZ until B's reference sits on the target.

It is deliberately not a replacement for either. A lock is followed by a Seat or
an Align, and the status line says so.

## Using it

In the Join card, with a Join started and A and B both picked (the same
precondition Center X, Center Z, Align and Seat all carry):

- **Center lock** — moves B so its centre sits on the target point.
- **Pick target** — arms the next canvas click. Click a point on **A** and that
  point becomes the target, and the lock runs on the spot: picking the point is
  also the request to lock onto it. Press the button again to cancel while
  armed. Right-click it to drop a stored target and go back to A's own centre.
- **Lock on bounding-box centre / Lock on centroid** — which reference point
  both pieces are read by.

With no target picked, the target is A's own reference point — so one press
centres B on A.

A is the piece that stays put. B is the piece that moves. Clicking B while a
pick is armed is refused with a message rather than silently taken as a target.

### The two reference modes

**Bounding-box centre** (default) is the centre of the piece's world
axis-aligned box, read top-down. It is what the eye reads as "the middle" from
above, and it is what Center X and Center Z already use.

**Centroid** is the volume centroid, by tetrahedron decomposition about the
origin: for each triangle `(a,b,c)` the tet `(0,a,b,c)` has signed volume
`det(a,b,c)/6` and centroid `(a+b+c)/4`, and the signed pieces of a closed
surface sum to the solid. It is exact for any watertight soup, and for a
symmetric piece it coincides with the box centre. For an L, a step or a piece
with a pocket the two differ — `fixtures/lid_strap.stl` is 60×48×2.4 with a step
that puts its centroid exactly 20/7 mm off its box centre.

A soup whose signed volumes cancel has no volume centroid — an open shell, a
sheet, anything not watertight. Rather than divide by noise, the mode falls back
to the area-weighted surface centroid and the status line says "surface
centroid" instead of "centroid".

## Y is not touched

Center lock is a pure XZ translation. Height comes from the bed settle that
every XZ move already does, via `applyPlacedXZ` — the same settle Align and
Center X/Z leave behind for Seat. Seat is what sets height against a skin, and
Center lock does not try to guess at it.

## What it reuses

The audit before building this found the pose math already factored, so none of
it is duplicated here:

| reused | from | for |
|---|---|---|
| `meshLocalBox3` | `app-finish.js` | the world AABB, hence the box centre |
| `meshToWorldSoup` | `app-join.js` | the world triangle soup, hence the centroid |
| `applyPlacedXZ` | `app-core.js` | the one writer of a placed piece's XZ, bed settle included |
| `snapshotPlacedPose` + `pushUndo` | `app-core.js` | one Undo entry per lock |
| the armed-click hook | `app-core.js` pointerdown | the same shape Soften, Cap and paint use |

The new code is `app-center-lock.js`: the two reference points, the target
bookkeeping, and the UI.

## Exactness

Because the move is a pure XZ translation and `state.modelGroup` carries no
transform of its own, the delta applied to `placed.x` / `placed.z` lands on the
world reference point one-for-one. After a lock, B's reference point **is** the
target:

- **Bounding-box mode is bit-exact.** `meshLocalBox3` works in doubles, so the
  residual is 0.
- **Centroid mode lands within ~1e-6 mm.** It reuses `meshToWorldSoup`, the
  app's shared world-soup helper, which returns a `Float32Array` — so the
  centroid carries float32 quantisation. Measured: 4.8e-7 mm. That is under a
  nanometre on a tool whose whole job is to get a piece close enough for Seat to
  take over, so the shared soup is reused as-is rather than duplicated in double
  precision. `tools/nso_center_lock_test.js` pins the size of that error so it
  cannot quietly grow.

## The check

`npm run centerlock:test` (also in `npm test`) drives the real app in Chromium —
`index.html`, every `app-*.js`, the real buttons, a real synthesized canvas
click. It gates on:

1. **Exactness** — both reference points are recomputed inside the test from the
   mesh's own geometry and world matrix, *not* by calling the app's helpers, so
   a wrong helper cannot agree with itself. Gate: 1e-6 mm.
2. **Known geometry** — the fixtures are boxes of stated size, so the landing
   values are known in advance and asserted as numbers, not just as "A and B now
   match". A is parked on a deliberately unround XZ first, because the origin is
   the one answer a broken lock could reach by accident.
3. **The modes are distinct** — `lid_strap`'s 20/7 mm centroid offset separates
   them. If centroid mode silently fell back to the bounding box the two would
   land on the same spot and the test would say so.
4. **Composition** — after a lock, Align still finds a wall and snaps B's edge
   to it (which moves B *off* the lock: that is the point), and Seat still
   reports its own verdict. Align is then run a second time from the same
   starting pose with no Center lock anywhere in the history, and the two must
   land on the same XZ to float precision — so the lock leaves nothing behind
   for the fine steps to trip on. It is just a pose.
5. **Undo, idempotence and the guards** — one Undo restores the pose, a second
   press is a no-op, and the controls disable and drop a stale target when the
   Join is cleared.
