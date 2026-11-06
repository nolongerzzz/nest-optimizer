# Extract bit

The bit is **the void you click**, shown before it is made. (It used to guess the biggest void and gave a slotted tube from a bolt
and a whole blob from a head.)

## Using it

1. **Extract bit** (Subtract card) arms the click. Click *inside* the void you want: a wall of it, or its bottom.
2. The tool finds that void and draws the bit it will make **in place, in amber**, the piece turned to a ghost round it. Nothing is
   on the plate yet; the piece is not touched.
3. Not the one you meant? Click another wall. Or set **Lid R** (blank = automatic): the preview follows the box.
   Too much taken in (it reached into the dents beside the opening): a smaller Lid R. Too little: a bigger one.
4. **Make bit** (or Enter) bakes it beside its source, one Undo. Escape puts the preview away; again, it stops the tool.

## How it works

- `nso_void.js` (`NSO_Void.select`) decides *which void*. It voxelises the piece, takes the click (nudged along the face's normal)
  as a node in the air, and **closes** the piece by a ball of radius R: every dent a ball that size cannot enter is filled, with a lid
  across the opening, the way a rolling ball bridges it. Closing less the piece, the part the click is in, is the void at R.
  R goes up from about a node until the void *holds* (the next radius grows it by no more than 30%): the smallest ball that closes
  it, so the least reach into its neighbours. It tries a small reach first (fine grid) then a large one (a bore nearly as wide as
  the piece). Its answer is the void's **wall**: the corners of the triangles that face it.
- `NSO_cavityCore` (`nso_csg.js`) makes it solid: the **convex hull of the wall's corners, less the piece**, the part holding the
  click. The bit's walls are the piece's own - a threaded hole gives a threaded rod, a hex socket a hex plug - exactly. The lid
  across the opening is the hull's: flat over a flat opening, a chord over a curved one.
- `app-extract-bit.js` is the card's side (arm, click, preview, Lid R, Make bit, Escape/Enter); `extractBitDetect` /
  `extractBitCommit` in `app-join.js` are the two steps. `extractBitFromSelected({ point, normal })` does both, for checks.

## Limits

- The click must be on a wall facing the air of the void (the face's normal is read to step into the air). A click on the outside of
  the piece is refused in words ("nothing closes over where you clicked").
- A piece that is not a closed solid is refused ("Seal it first"); overlapping shells are merged for the operation, as for the rest.
- The void-finder runs on the page's thread (about a second on a bore, up to a few seconds on a large piece); the boolean after it
  goes to the worker when the piece is big.
- A void with a very wide opening next to dents about as wide (a smooth mouth between bumps) can take in a neighbour at the smallest
  closing ball: look at the amber, and set Lid R.

Gates: `extract:bit-exact` (node: tube, threaded hole, Allen socket, two holes, two cavities, outside clicks) and `extract:bit-drive`
(the real app: preview before the bake, Lid R live, Escape, Make bit, Undo, a real pointer click).
