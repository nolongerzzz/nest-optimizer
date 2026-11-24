# Soften on a curved rim - a drawn outline, a D, a disc

`rawPerimeterFilletBuild` and `softenSelectedFace` in `app-finish.js`, the lid trim in `app-cut.js`. Check: `npm run soften:rim`
(headless) and section 8 of `npm run soften:live` (the card, in the app).

A face whose rim bends - a Custom shape outline with rounded corners, a bulged side, a cylinder end - is softened a face at a time: open
Surface & edges > Soften, pick a style and R, click the face, Soften bakes what the preview shows. The piece that showed what was wrong with
that was a Custom shape frame thickened into a wrist rest: a D 59 x 172 mm, a 24 mm slab on top, 2.5 mm walls, a pocket underneath, corners
r 8.

## What each style does on a curved rim

| Style | On a rim with no square corner |
| --- | --- |
| **Round** | the whole rim, a quarter circle of R, at the R asked |
| **Bevel** | the whole rim, one 45 degree band of R |
| **Corners+edges** | the same as Round, and the status says so: `corners+edges: this rim bends in curves, so all of it is rounded`. The setback blend needs square corners joined by straight edges; a rim with no corner on it is all edge |
| **Corners** | refused in words: it puts a ball on square corners and the face has none. Corners+edges or Round rounds the rim |

A face with **some** square corners and some curves (a Custom shape with radius 0 on two corners) takes Corners+edges as the rim round
too - the setback used to band "between" the sharp corners across the curves and come out open (77 open edges on a 60 x 40 face). A face
whose corners are all sharp but one is reflex (an L) is still refused, now as "needs all 6 corners of this face square - 1 is a curve,
reflex or not square", not as "already softened". Only a corner that really backs onto a softened face says that.

## R larger than a bend

An inset larger than a bend's radius folds the ring back over itself. `rawRimTrimFolds2` cuts the fold off where the ring crosses, which is
what an inset by that distance is: the round from each side of the bend meets along the bend's bisector in a **soft hip**. On the wrist rest,
R 10 and R 15 both bake over the r 8 corners; the status counts the bends (`4 bends tighter than R meet in a soft hip`). A smooth corner at
that R needs the outline drawn with corners at least R (Custom shape's corner radius).

What a face cannot take is still refused, with the number (`rawSoftenWithLimit`): a face pinched in two (a neck narrower than 2R), a ring
turned inside out (a strip narrower than 2R), a hole too close to the edge. R 30 on a 50 mm wide face says `R must be under 22.9`.

## What changed

- **No per-point clamp.** The outline's R used to be clamped point by point to 0.45 x the nearest loop point other than its two neighbours.
  On a finely sampled curve that is the point two steps along the same curve: the wrist rest's 1 mm steps read as a 2 mm wall and R 15 came out
  R 3.27, reported only as "wall clamp". A Ø20 rod asked R 1.1 built 0.59. A clamp that varies along a loop also bends the ring backwards
  without crossing, which nothing downstream can see. Every point now carries the R asked; the limits above refuse instead.
- **Rows.** Six rows evenly spaced in height, as Round always had, while their facets stay within 0.05 mm of the arc (R up to about 1.2);
  past that, rows of equal angle, as many as keep every facet within 0.05 mm (`rawRimRows`: 10 at R 15, at most 32).
- The non-convex lid trim (`rawLidSubtractBand2`) drops a band quad's repeated corner, which a trimmed fold leaves.

## Checks

`npm run soften:rim` builds the pieces with Custom shape itself: the wrist rest (a tray with a 24 mm floor is that shell upside down) at
R 5 and R 15, Round / Bevel / Corners+edges / Corners; the quarter circle along a straight side and the hip on the bisector; the refusal and
its number on a 50 mm face; a 30 mm rod at R 10; two sharp corners and two rounded ones; the rows. Every result through
`tools/mesh_validate.py`. `npm run soften:holes` re-pins the rod at R 1.1 to the R asked.

## Not here

The hip is a crease, soft but visible at R well past the bend; a true rolling-ball blend there would also round the wall's corner below
the band. Corners (ball only) on a face with sharp and rounded corners still leaves inconsistent winding along the curves - pre-existing,
separate from this.
