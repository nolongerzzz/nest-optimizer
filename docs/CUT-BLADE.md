# Cut: the sized blade

The Cut card's blade has two modes.

- **Full blade** (the default, unchanged): a plane across the whole piece. It
  splits everything in its path, all the way through, with no kerf. One piece
  becomes two that add back to the original.
- **Sized blade**: a *box* - `Width` across the cut, `Depth` into the piece,
  `Kerf` thick - that takes out only its own volume. Use it to cut **between**
  things (a blade narrower than the section leaves whatever else is in the
  full blade's path alone) and to cut **into** a face without going through
  (a notch: a blade that stops short of the far side).

Files: `nso_notch.js` (the geometry, THREE-free, `npm run notch:test`),
`app-cut.js` (`cutBladeSpec`, `cutBuildSizedBlade`, `cutNotchAt`, the card
wiring), the Blade rows in `index.html`. Real-browser check:
`npm run notch:drive`.

## Why a box, not a thinner plane

A cut that stops partway has a floor, and a floor needs a width: a
zero-thickness slit inside a solid is not a manifold. So the sized blade is a
solid and the cut is that solid subtracted from the piece (the manifold kernel,
the same `NSO_CSG` Carve and Subtract use). Kerf has a floor of 0.2 mm; under a
nozzle width a slot cannot print, and the card clamps what you type to it.

The full blade stays a split because a split is a different thing: the halves
meet exactly. A sized blade that happens to cover the whole section severs the
piece and loses the kerf, and says so (see below).

## Using it

1. Open **Cut**, press **Sized blade**, set Width / Depth / Kerf.
2. **Click the face** the blade should go into. The blade drops there, centred
   on the click across its width, and goes in *against that face's normal*: a
   click on a top face comes down, a click on a side face comes in from the
   side. The readout says which ("down from the top", "in from the side").
   A face lying in the cut plane has no sideways lean to read, so the blade
   comes down from above.
3. Slide it along the piece with the slider / arrows as before; angle it with
   the mitre and bevel as before. The blade is drawn as the box it will cut.
   (Clicking *inside* the blade's own box still drags the blade, as it always
   did; click the piece outside it to move the anchor.)
4. **Cut.** One Undo (`Undo: Notch reverted`) puts the piece back vertex for vertex.

The blade starts 1 mm clear of the face so its edge is never coplanar with it.
That 1 mm is air: **Depth is measured from the face**, and the volume taken is
exactly `kerf x width x depth` (checked to 0.05 mm^3 against the piece's own
volume, at mitre and bevel too - the slant of a bevelled blade averages out
across the kerf).

## What can come out

- **A notch** - one piece, closed (0 open, 0 non-manifold edges).
- **A severed piece** - a blade at least as wide and deep as the section. The
  result is still *one piece* holding several bodies; the status says
  "the slot severs the piece into N bodies" and **Split to parts** separates them.
- **A refusal, with the piece untouched** - kerf / width / depth under the
  floor, a blade that does not reach the piece, a piece that is not a closed
  solid the kernel can cut, or a cut that would leave nothing.

## Not done (said plainly)

- **No wall-thickness check.** A notch that stops 0.2 mm short of the far side
  is cut, and leaves a 0.2 mm skin. Carve refuses that (`NSO_Thickness`); this
  does not yet. Run **Check piece** after a deep notch.
- **Position is by click.** There is no in-plane drag or typed offset for the
  blade; to move it sideways, click again. After a cut the anchor resets (the
  piece is re-centred) and the next blade starts at the top of the section.
- **Pockets.** A face *parallel* to the cut plane cannot be pocketed by Depth
  (the blade enters along the plane, not through it). Use Kerf as the pocket
  depth and slide the plane to the face.
- **Curved faces** use the tangent plane at the click.
- **Mitre and bevel** are supported; bevel is checked on a flat top face only.
