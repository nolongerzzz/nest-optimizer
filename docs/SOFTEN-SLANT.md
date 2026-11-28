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

The profile is fitted per outline POINT, not per edge: the part across the face is mitred as the square-wall round
mitres it, and the part down the wall runs along the line the point's two wall facets share (on a faceted tube, the
tube's own line), or their common direction where they are one plane. Per-edge offsets were tried first: a Cut
outline is unevenly spaced (a 0.2 mm edge between 1.5 mm ones), and offsets differing edge to edge slid a mitre far
along a short edge and turned it backwards ("turns this face inside out"). Faces whose walls are all square to them (to 1e-6) take the old construction unchanged - the pinned
results in `soften:holes` and `soften:rim` hold.

This applies on axis faces too: a tube cut at 45 degrees and then laid on its cut has square-to-axis face and
leaning walls, and gets the fitted round.

## Faces the Cut tool made

These failed whatever the angle - a cut straight across a tube too - and were what the owner hit first:

- **The slit.** Cut fills an annulus through a slit from the outline to the hole. Trimming those triangles back to
  the rounded edge split the slit's two sides at different points, and the lid came out open (or the trim's area
  check refused: `the lid did not trim cleanly`). When the trim refuses, or leaves the piece less sealed than it
  was, the lid is laid fresh inside the rings instead - a constrained Delaunay triangulation of the rings themselves
  (`rawFreshLid2`, `nso_cdt.js`). Every face tries the trim first, so faces it always worked on are unchanged.
- **The close points.** Cut leaves outline points 0.005 mm apart; the rim's 0.08 mm weld takes some out, and the
  wall vertices there met the band's foot in T-junctions. Each is now recorded against its loop segment and the
  band's first row is stitched through it (`L.bottom` in `rawCapRebuildFromRings`).

`soften:slant` section 6 cuts a Stock tube with the Cut card's own split at Bevel 45 and Bevel 90 and softens every
cut face of both halves.

## Not here

A slanted face's Full wrap (every face at once) - a slanted piece is never a box. The angle is clamped to 20 - 160
degrees; a knife edge sharper than 20 degrees is rounded as if it were 20.
