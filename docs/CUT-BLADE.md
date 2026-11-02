# Cut: the sized blade, strands, and notches

The Cut card's blade has three modes (the Blade row), and two switches above it.

- **Full blade** (the default, unchanged): a plane across the whole piece. It
  splits everything in its path, all the way through, with no kerf. One piece
  becomes two that add back to the original.
- **Sized blade**: a *box* - `Width` across the cut, `Depth` into the piece,
  `Kerf` thick - that takes out only its own volume. Use it to cut **between**
  things (a blade narrower than the section leaves whatever else is in the
  full blade's path alone) and to cut **into** a face without going through.
  With **Single strand** on (the default) it takes only the *strand under the
  click*, even where its box holds several - see below.
- **Notch**: click a strand (a cord, one turn of a spiral). The blade fits that
  strand and cuts a **nick** in from its edge, `Notch width` along the strand
  and `Notch depth` in. It never goes through, and only that strand is touched.

Switches:

- **Adjust blade** (on by default): when off, the blade is parked. Its controls
  (slider, nudges, mitre and bevel dials, the Blade row) are inert and a click or
  drag on the plate no longer places or slides it, so nothing you do to the piece
  or the view can shift it. A click still selects the piece. Pieces still do not
  move while Cut is open (that is the app's rule, and it says so).
- **Rotate piece**: shows the rotate rings on the piece while Cut stays open.
  Turn is on; *Lean front/back* and *Lean side/side* appear as options. Drag a
  ring and the piece turns and the blade follows it. The arrow keys are not
  taken (Cut's dials use them; one press is answered once).

Files: `nso_notch.js` (the geometry, THREE-free, `npm run notch:test`),
`app-cut.js` (`cutBladeSpec`, `cutBuildSizedBlade`, `cutNotchAt`, the card
wiring), `app-core.js` (the click's point and face, the Adjust blade gate, the
ring grab under Cut), `app-rotate-handles.js` (rings under Cut), the Cut card
in `index.html`. Real-browser checks: `npm run notch:drive` (bars) and
`npm run notch:strand-drive` (a spiral of cord).

## Why a box, not a thinner plane

A cut that stops partway has a floor, and a floor needs a width: a
zero-thickness slit inside a solid is not a manifold. So the sized blade is a
solid and the cut is that solid subtracted from the piece (the manifold kernel,
the same `NSO_CSG` Carve and Subtract use). Kerf / notch width has a floor of
0.2 mm; under a nozzle width a slot cannot print, and the card clamps what you
type to it.

The full blade stays a split because a split is a different thing: the halves
meet exactly. A sized blade that happens to cover the whole section severs the
piece and loses the kerf, and says so.

## Strands

Cut a spiral of cord with a plane and the section is not one shape but one
**blob per turn the plane crosses**. `NSO_Notch.sectionClusters` slices the
piece's triangles at the plane and joins the section segments that share an end;
each group is a strand. The one whose outline passes nearest where the click met
the plane is "the" strand (distance is to the outline's segments, not its
corners - a click mid-way along a long flat face is far from its own corners).
It is outlined in yellow in the viewport and named in the readout ("1 of 6").

- **Sized + Single strand**: what the blade's box holds is split into one solid
  per strand (`decompose`); the one nearest the click is taken, the others stay.
- **Notch**: the blade is made as wide as that strand's own section plus 0.5 mm
  each side, and starts at the strand's *own edge* on the side the click came
  from: a click on the top of a cord goes in from the top, on its flank goes in
  from the side. `Notch depth` is measured from that edge.

Checked, not assumed: on a spiral, the strand cut removes the same volume as a
plain blade narrowed to just that strand with detection off (10.6488 vs
10.6487 mm^3), and a notch of twice the width takes 2.016 times the volume, as a
slab of twice the thickness must.

### One thing that was wrong on the way, and why it is the way it is

The first strand cut subtracted *the strand's own piece* (blade ∩ piece) from
the piece. That solid's skin lies exactly on the piece's own skin, and a boolean
on coincident faces left a **pinched edge shared by four triangles** (found on
the real connector-string file: 0 non-manifold edges before, 1 after - at every
weld tolerance, with the kernel itself reporting a valid manifold). The blade is
now subtracted instead, clipped to a box a hair (0.05 mm) bigger than that
strand's extent, so nothing it does touches the piece's skin; the same volume
comes out and the result is clean. If another strand comes inside that clip box
the clip would take it too (checked by volume), so the exact piece is used and
the status line carries a warning if the result is not clean. The spiral drive
check asserts 0 open / 0 non-manifold edges on every cut.

## Using it

1. Open **Cut**. Pick **Sized blade** or **Notch**.
2. **Click the face** the blade should go into. It anchors there and goes in
   *against that face's normal*: a click on a top face comes down, on a side face
   comes in from the side. The readout says which. A face lying in the cut plane
   has no sideways lean to read, so the blade comes down from above.
3. Slide it along the piece with the slider / arrows; angle it with the mitre and
   bevel. The blade is drawn as the box it will cut. (Clicking *inside* the
   blade's own box still drags the blade, as it always did; click the piece
   outside it to move the anchor.)
4. **Cut.** One Undo (`Undo: Notch reverted`) puts the piece back vertex for vertex.

The sized blade starts 1 mm clear of the face so its edge is never coplanar with
it. That 1 mm is air: **Depth is measured from the face** (for Notch, from the
strand's edge), and the volume taken is exactly `kerf x width x depth` on a flat
face, at mitre and bevel too (the slant of a bevelled blade averages out across
the kerf). The blade starts where the clicked face meets the *plane*, not where
you clicked - a bevel swings the plane away from the click, and a blade started
from the click's depth ends up buried.

## What can come out

- **A notch / nick** - one piece, closed (0 open, 0 non-manifold edges).
- **A severed piece** - a blade through a strand, or wide and deep enough to
  cover the section. The result is still *one piece* holding several bodies; the
  status says "the slot severs the piece into N bodies" and **Split to parts**
  separates them.
- **A refusal, with the piece untouched** - kerf / width / depth under the floor,
  a Notch whose plane crosses nothing ("slide it onto a strand"), a blade that
  does not reach the piece, a piece that is not a closed solid the kernel can
  cut, or a cut that would leave nothing.

## Not done (said plainly)

- **No wall-thickness check.** A notch that stops 0.2 mm short of the far side is
  cut as asked and leaves a 0.2 mm skin. Carve refuses that (`NSO_Thickness`);
  this does not yet. Run **Check piece** after a deep notch.
- **Notch is a nick across the strand, not a groove along it.** A channel that
  follows a strand's edge lengthwise round the spiral is a different, larger
  tool (path-following) and is not built.
- **Position is by click.** No in-plane drag or typed offset; to move the blade
  sideways, click again. After a cut the anchor resets (the piece is re-centred).
- **Pockets.** A face *parallel* to the cut plane cannot be pocketed by Depth.
  Use Kerf as the pocket depth and slide the plane to the face.
- **Curved faces** use the tangent plane at the click.
- **Single strand** picks by the plane's section, so two strands that *touch*
  (one blob) are one strand.
- **Mitre and bevel** are supported; bevel is checked on a flat top face only.
- **Adjust blade off** does not let pieces move while Cut is open.
