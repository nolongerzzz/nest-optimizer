# Weave

Cut a patch out of a piece along its own triangles, weave a fresh one in its place, and
reattach it corner for corner. It is the clean way to take engraved text off a scan
(`text_repair_test.3mf`, the DUKE DOKS hand), and the way to re-mesh any patch of a
surface evenly. The engine is `nso_weave.js` over `nso_cdt.js` (both THREE-free,
node-tested: `npm run weave:test`); the card is `app-weave.js` (the left bar's **WEAVE**,
under Text; `npm run weave:drive`).

## The idea

Every corner of a mesh is a place it can be cut. Pick a patch of the surface and it comes
out along the edges of its own triangles, like a puzzle piece. What comes out is the
**plate**; what is left is a hole whose rim is a loop of the mesh's own corners. The new
patch is built to fit that hole and nothing else:

- **Its rim is the rim.** Every rim corner is a corner of a new triangle, no rim edge is
  split, and the new triangles run the same way round the rim the old ones did. The join is
  watertight with no weld, no boolean and nothing to repair. The rim corners are written back
  as the mesh's own coordinates, bit for bit.
- **Its inside is woven fresh.** A hex lattice at the plate's own triangle size (its median
  edge, so the weave resembles the mesh round it), graded in from the rim's corner spacing,
  thinned where the grading wants finer, relaxed, and triangulated as a constrained Delaunay
  (`nso_cdt.js`). An even mesh, not the scan's.
- **Its corners stand on a surface fitted over the plate.** The plate is read as a height
  field along its mean normal. *Smooth* (the default) bridges the work on it; *Follow* keeps
  the plate's own surface and only re-weaves it.

## Using it

Open WEAVE; the pointer is the tool. With X-ray on, the plate (amber), its rim and the rim's
corners (the dots: the places it is cut at) and the new weave (green wireframe) are drawn over
the wireframe.

1. **Cut.** *Circle*: press on the surface and drag out to the size you want (a click alone
   takes the Radius field's; it follows the surface, so it does not wrap round a finger).
   *Lasso*: draw round the part; it takes the surface that faces the camera (and, like the
   circle, only what faces roughly the way that surface does, so a wall of the piece inside the
   loop is not taken), so it works through X-ray.
   Shift adds to the cut, Alt takes away. **Grow** / **Shrink** move the edge one ring of
   triangles; **Clear** (Escape) lets go. Small holes in a cut (a letter's counter, the back
   wall of a recess) are closed automatically; a corner where the outline touches itself is
   opened; of several pieces joined only at a corner the biggest stays.
2. **WEAVE.** Fits and draws the new patch; nothing is changed. **Pitch** is the triangle size
   (blank: the plate's own). A refusal says why, in words.
3. **REATTACH.** Puts it in, rim to rim. Mesh surgery, no boolean; one Undo (`weaveReplace`).

## How the surface is fitted (Smooth)

1. **Look down.** The plate (and the ring of mesh just outside its rim, so a node beside the
   rim has the real surface under it) is rasterized onto a grid (about a third of the pitch):
   the height of the face seen from above at each node, along the plate's mean normal.
2. **Find the work by its walls.** A drop of more than 55 degrees between neighbouring
   nodes is a wall (an engraving cut into a coarse mesh leans: the first version's 65 degrees
   found a stroke or missed it by where the circle's centre fell), and so is a *crease* (the slope turning sharply over three nodes: a wall's
   foot and top - they shut the gap a gentler wall would leave; the tolerance is 0.04 mm or
   8 times the data's own roughness, whichever is more, so a noisy scan does not crumble into
   creases). Walls gentler than about 45 degrees are a dish, not work. The walls cut the field into
   pieces. The big ones (15% of the biggest) are the face; a small one that walls shut in is
   work (a pit's floor, a boss's top, the island inside an O); a sliver of the outline's
   jagged edge with no wall touching it is face. The work is widened by two nodes for its
   walls' slopes. **Raised work goes the same way as engraved**: both are pieces the walls cut
   off.
3. **The face carried across.** A quadratic is fitted by *moving least squares* to the face
   round each node of a coarse lattice over the work (the reach grows with the distance to the
   nearest face), bilinear between, so it follows a curved face (a sphere, a palm) and not just
   a plane. The small mismatch between it and the real face at the work's edge is spread inward
   by Laplace's equation, so the new surface meets the old with no step.
4. **The rim.** The last mismatch between the surface and the rim corners themselves is carried
   inward over 1 mm (a screened Laplace equation), so the new corners meet the rim flush.

*Follow* skips 2 and 3: the surface is the plate's own height field. Steep walls come out as
stretched triangles, because the weave is 2.5D.

## What it needs, and refuses in words

- **A patch that lies flat along its mean direction**: its outline, flattened, must not cross
  itself, and no more than 30% of it may face away. A cut that curls round too far (a circle
  the size of a palm on a hand, a finger) is refused: *"the selection curls round too far to lay
  flat (its face turns N° from its mean direction) - cut a smaller piece"*; or *"the
  selection's outline folds over itself when flattened (near x, y mm from its middle) - the cut
  runs along a wall or a fold"*.
- **A crop whose edge falls on clean face round the work.** If the edge runs through the work,
  rim corners stand off the fitted face: *"the crop's edge cuts through the work: N of its M
  rim corners stand D mm off the face, on the work. Widen the crop so its edge falls on clean
  face round the work."* The corners that stand on it are drawn red.
- `the selection is the whole piece`, `nothing is selected`, `the selection touches itself at N
  corner(s)`, `the cut runs along an edge three triangles share`, `that patch would need about N
  triangles at a pitch of P mm - raise the pitch`.
- **Paint stands it down.** A new patch renumbers triangles and paint names its faces by axis
  and side, so any paint on the piece stands Weave down, naming the count (the same rule as
  Text: `PAINT SCOPE: WHOLE-PIECE`).

## Results

| piece | cut | result |
|---|---|---|
| fixture: a jittered slab under a R30 cap, four strokes and a ring engraved 0.6 mm | a 13 mm circle, 31,214 triangles | 31,214 -> 25,196 triangles; new corners within 0.007 mm of the cap the engraving was cut from (rms 0.001); volume 872.19 against the unengraved slab's 872.30 (engraved: 820.23); the app's checker finds the piece exactly as closed as it was |
| fixture, Follow, no engraving | a 9 mm circle | corners within 0.0013 mm of the plate's surface |
| fixture, a ring cut (a hole in the patch) | 11 mm out, 8.5 mm in | two outlines, weaves, closed |
| `text_repair_test.3mf` palm: DUKE DOKS, 148,578 triangles, self-piercing shells | a 7 mm circle on the text: 12,232 triangles, rim 242 corners | 12,232 -> 12,116 triangles at 0.17 mm (the plate's own), edges p50 0.167, angles p1 41 / p5 53 degrees, none turned; 37 mm² of work 0.86 mm deep bridged; 1.3 s; open 0, non-manifold 0, flipped 0, degenerate 0; piercing pairs 2544 -> 145 (the old skin was where they were) |

An 8 mm circle on the same palm is refused (its edge runs across a crease of the palm: 18 of
325 rim corners stand 0.53 mm off the face); a 12 mm one is refused (it curls round too far to
lay flat). The text is about 10 mm across, so a 7 mm circle takes all of it; a lasso takes any
shape.

## Against Text > Remove (docs/RESURFACE.md)

Text > Remove finds the work for you (rays down a box, walls cut the height field) and drops
the skin triangles whose centre stands over the work and a margin. Where the rim of that hole is
noisy (a scan's splinters and folds) it falls back to zipping a strip to a clean outline, and
the new triangles are 1 mm ones refined where the surface sags. Weave leaves the cut to you, so
the rim is where you put it (and the engine says if it is on the work); the new patch is an even
weave at the mesh's own size; and the join is exact because it is by construction, not by a
fallback.

Measured on `text_repair_test.3mf` (`NSO_Resurface.scan` over the palm: 10 pieces of work, the
checker closed in every case):

| | Text > Remove | Weave |
|---|---|---|
| the whole word | all 10 pieces at once: refused, *"the outline could not be closed (the letters could not be triangulated cleanly (a flat or turned triangle))"* | one 7 mm circle: done |
| a piece at a time | 9 of 10 apply; the 10th is refused the same way | - |
| the new triangles' edges (the mesh's own: 0.17 mm) | p50 0.37 to 0.71 mm, p95 1.0 to 2.8 mm | p50 0.167, p95 0.205 mm |
| the new triangles' angles | 1st percentile 0.3 to 1.8 degrees, 5th 1.1 to 4.8 (slivers) | 1st percentile 41 degrees, 5th 53 |
| the face over the letters | carried by the same kind of fit | corners within 0.007 mm of the true surface on the fixture |

## Not yet

- A pitch that changes across the patch (finer at a feature).
- Keeping the plate: the old patch as a piece of its own (as Crop copies a region out).
- Patches that do not lie flat along one direction (a cut that wraps a finger): a parametrized
  weave (the engine is a height field and says so).
- X-ray: the app drops X-ray on any bake's new mesh (`applyXrayView` is nested in app-join.js,
  so `updateAdjustUI` never reaches it - true of Text, Brush and the rest too); Weave puts it back
  itself after REATTACH (`NSO_weaveKeepXray`). A one-line export of `applyXrayView` would fix it
  for every tool; that is a behaviour change for all of them, so it is not made here.
