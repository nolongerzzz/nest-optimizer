# Cut: Follow strand - slice a spiral like salami

The Sized blade is square to the piece's own axes. On a spiral of cord that is
square across one turn and slanted across every other. **Follow strand** (one box
on the Sized blade; it is also "take only the strand under the blade", which used to
be a box of its own) puts the blade square across the cord wherever it runs and
walks it along the cord, a slice at a time. It is **on as soon as the Sized blade is
picked** (the Sized blade is for work like this, between things on a strand); untick it
for the plain Sized blade: square to the piece, taking everything in its box - what to use
to cut a slot into a face, say.

1. Pick **Sized blade**, tick **Follow strand**, and click the cord. The strand's
   centre line is traced, the blade is turned (mitre and bevel, the card's own
   dials) until it stands square across the cord there, and put on its centre. The
   card raises Depth and Width if they would not go through the cord, and says so.
2. **Slice** is the material left between two cuts (default 1.5 mm); the blade takes
   its Kerf (default 1 mm) on top, so a step is slice + kerf (2.5 mm). **Back** and
   **Forward** move the blade one step along the cord without cutting, round the
   bends, and stay square. The way last pressed is the way Cut goes on.
3. **Cut** cuts, and moves on to the next slice by itself. Click Cut again, and
   again, from one end of the spiral to the other. The cut that severs the cord
   separates it into pieces (as any sized cut does), and the blade carries on onto
   whichever piece holds the next slice. The last slice says so.

## Sliding along the cord

The position slider, its number box, the ← / → nudges and a drag in the viewport all
slide the blade **along the cord** (not along a straight line, which would pull it off
it), square to the cord all the way.

- Putting the blade on the cord also traces the cord's centre line either side of it, out
  to a quarter turn (90 degrees of turning, or 60 mm) each way: the blade's **stretch**.
  The slider is that stretch - 0 at its start, the thumb where the blade is - and the
  readout says how far along it you are. A drag in the viewport (press on the blade, or
  on the cord, which also puts the blade there) takes the point of the stretch nearest
  the pointer's ray.
- Sliding is a walk through the traced line, with no new work on the mesh (about 13 ms a
  step on the Connector string), so it follows the hand. It never stops in a kerf an
  earlier cut left: it goes over the gap onto the pieces beyond.
- **Let go** - the mouse, the slider, or a 0.6 s pause on the keys - and the blade is put
  down for real: traced again, with a new stretch centred on it. A second drag goes on
  another quarter turn, and so on round the spiral, section by section. Held, it is not
  put down under your hand.
- Press **Cut** and it cuts where the blade stands, then moves on to the next slice as
  before.

Back is off where the step back is a cut already (the kerf is empty: there is no
strand to stand the blade on). Clicking the cord's flat end is refused: the plane
there has no section of its own to read. Click a millimetre in.

## How it finds the cord (`nso_strand.js`, THREE-free, `npm run strand:test`)

Everything is in the world frame, over every piece on the plate at once, so the
strand carries on across the kerfs earlier cuts left.

- **Direction** from the surface around the click: every normal of a tube lies
  square to its axis. Pairs of sampled normals propose an axis (their cross
  product); the one square to the most surface area wins (so the flat cap of the
  cord's end, whose normals lie *along* the axis, is outvoted), and the winners'
  covariance gives the exact direction. (The first version took the plane that cut
  the smallest section; a plane that grazes the surface or the end cuts a tiny one.)
- **Centre** is the section's outline, weighted by length. The directions a little
  ahead and a little behind are read again from the centres of the sections there,
  which sit on the axis even when the plane is oblique.
- **Marching** (`advance`): steps of 0.5 mm, each re-centred on the strand's own
  section. A section must be a whole one of the cord (its area within a fifth of the
  one at the start): the plane that lies on a cut face or just inside the end cuts
  part of a disc, whose centre is off the axis. Gaps up to kerf + 1.5 mm are
  crossed straight; a march that finishes with no strand under it has run off the end.

## Checked

`npm run strand:test`: against a generated spiral (flat and climbing) the centre is
on the centre line to 0.05 mm and the direction within 1 degree, 12 steps of 2.5 mm
stay on it (worst 0.05 mm), a 1 mm gap is crossed (0.006 mm off) and the end is found.
`npm run follow:drive` (real Chromium, real kernel, real mouse; the slide gates are the last half): the blade within 0.2 degrees of
square on the cord, Forward 2.50 mm, Back home, three Cuts running (3 x 1 mm of
the cord's section removed, slices 14.2 and 15.1 mm^3 for 14.8 expected, 0 open /
0 non-manifold edges), and the last slice at the cord's end. Also run by hand on the
Connector (string) 3MF the feature was asked for on.

## Limits

- A cut takes a few seconds on a big piece (the boolean kernel and Split to parts
  run each time); a 300 mm cord is a hundred and twenty slices.
- The blade comes down from above (the plate vertical): a cord standing on end is
  cut from the side, as the Sized blade always does for a face in the cut plane.
- A slide covers a quarter turn each way at a time (`CUT_FOLLOW_TURN_DEG`, `CUT_FOLLOW_MAX_MM`
  in `app-cut-follow.js`); to go further, let go and slide again.
- Turning the Mitre or Bevel wheel, or the piece, while Follow is on takes the blade off the cord
  (and the piece's turn forgets the stretch): click the cord again.
