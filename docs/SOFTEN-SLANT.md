# Soften on a slanted face, and on walls that lean

`storeObliquePick`, `softenObliqueFace`, `rawLoopWallLean` and `rawLeanRing` in `app-finish.js`; the wall drop in
`rawCapRebuildFromRings` (`app-cut.js`). Check: `npm run soften:slant` (headless at four angles, then the live card
in the app with real clicks).

The piece that showed it: a stock tube with its end cut off at 45 degrees. A click on the cut face said
`Click a flat face - that spot is on a curve` - the pick only knew faces square to an axis.

## The pick

While Soften is armed (or the live Soften card is open), a click on a flat face square to no axis is taken as a
**slanted pick**: the face's outward normal in the piece's raw space (area weighted over the raw patch on that
plane, not the one triangle under the cursor) and its plane along that normal. It must be the outermost plane that
way; a parallel face further in is refused as recessed. Cap and the other face tools keep their axis faces only.
Paint excludes a slanted face by its normal and plane (`nsoMaskIsExcludedPick` takes the normal).

## The bake

`softenObliqueFace` turns the piece until the normal is +Z, softens the top face with the same per-face engine
(`softenSelectedFace`), and turns it back. Every vertex the engine did not move is put back on its original
coordinates bit for bit, so the rest of the piece is not left with the rotation's rounding (the flat end of the
tube is checked unchanged).

## Walls that lean

The rim round was built for walls square to the face: every ring point straight down the axis from its loop point.
On a 45 degree cut the wall leans, and the band's foot stood off the wall - up to `R sin(lean)` proud of the piece, a
lip. Now, per loop edge, the direction down the wall (`rawLoopWallLean`, off the wall triangles on that edge) and the
angle `a` it makes with the face set the profile (`rawLeanRing`):

| Style | On a leaning wall |
| --- | --- |
| **Round** | the arc of radius R tangent to face and wall; it touches each `R / tan(a/2)` from the edge - R at 90 degrees, more on the sharp side of the cut, less on the blunt side |
| **Bevel** | a flat band, R along the face and R along the wall |
| **Corners+edges** | the whole rim rounded, as Round, and the status says the walls lean |
| **Corners** | refused in words: it puts balls on corners between square walls |

At a corner of the outline a row's point is where its two edges' offset lines come closest (the mitre, on square
walls); the band's first row sits on the line the two walls share, so the wall's top edge, dropped to it, stays in
its own planes. Faces whose walls are all square to them (to 1e-6) take the old construction unchanged - the pinned
results in `soften:holes` and `soften:rim` hold.

This applies on axis faces too: a tube cut at 45 degrees and then laid on its cut has square-to-axis face and
leaning walls, and gets the fitted round.

## Not here

A slanted face's Full wrap (every face at once) - a slanted piece is never a box. The angle is clamped to 20 - 160
degrees; a knife edge sharper than 20 degrees is rounded as if it were 20.
