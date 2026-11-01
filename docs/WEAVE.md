# Weave

Draw a lasso round part of a piece's surface: it is cut out along the piece's own triangles,
and a fresh, evenly woven patch of **the same surface** - curved, grooved, saddled as it was -
takes its place, reattached corner for corner. It is the clean way to take engraved text off a
scan (`text_repair_test.3mf`, the DUKE DOKS hand), and the way to re-mesh any patch of a surface
evenly. The engine is `nso_weave.js` over `nso_cdt.js` (both THREE-free, node-tested:
`npm run weave:test`); the card is `app-weave.js` (the left bar's **WEAVE**, under Text;
`npm run weave:drive`).

## The idea

Every corner of a mesh is a place it can be cut. A selection of triangles comes out along their
own edges, like a puzzle piece. What comes out is the **plate**; what is left is a hole whose rim
is a loop of the mesh's own corners. The new patch is built to fit that hole and nothing else:

- **Its rim is the rim.** Every rim corner is a corner of a new triangle, no rim edge is split,
  and the new triangles run the same way round the rim the old ones did. The join is watertight
  with no weld, no boolean and nothing to repair. The rim corners are written back as the mesh's
  own coordinates, bit for bit.
- **Its surface is the plate's surface, cloned.** No plane, no projection direction, no limit on
  how far the patch curves: the patch is remeshed where it stands, on the surface (below).
- **Its triangles are even and the plate's own size** (the median edge of the plate, so the weave
  resembles the mesh round it; Pitch overrides).

## Using it

Open WEAVE; the pointer is the tool. With X-ray on, the plate (amber), its rim and the rim's
corners (the dots: the places it is cut at) and the new weave (green wireframe) are drawn over
the wireframe.

1. **Cut with the lasso.** Press on the piece and draw round the part. The loop is drawn flat on
   the screen but **cuts like a cylinder along the view**: it takes the surface that faces you
   inside it, whatever the surface does there - a palm's curve, a groove, the web between
   fingers. Shift adds another loop, Alt takes one away (a bite taken out of the middle stays a
   hole). **Grow** / **Shrink** move the edge one ring of triangles; **Clear** (Escape) lets go.
   Small holes in a cut (a letter's counter, the walls of a recess that face away) are closed
   automatically; a corner where the outline touches itself is opened; of several pieces joined
   only at a corner the biggest stays.
2. **WEAVE.** Builds and draws the new patch; nothing is changed. **Smooth** bridges the work on
   the plate (an engraving, a boss, a gouge); **Follow** keeps the plate's own surface and only
   re-weaves it. A refusal says why, in words.
3. **REATTACH.** Puts it in, rim to rim. Mesh surgery, no boolean; one Undo (`weaveReplace`).

## How it works

1. **The plate** is the selection after `close()`. No direction or flatness is read from it.
2. **Work is found on the mesh, by its creases and its walls** (Smooth only): neighbouring triangles
   whose normals differ by more than 35 degrees are not joined, and neither is a steep triangle (more
   than 55 degrees from the mean normal of the selection round it - a filleted lip turns the normal a
   quarter turn over several triangles, none of them a crease, but the wall itself is steep); what is
   left falls into pieces. The big ones (15% of the biggest, by area) are the face; the small ones are work - a
   pit's floor and walls, a boss, the island inside an O. Raised work goes the same way as
   engraved. The work is widened by a ring of triangles (its lips), specks of face shut in by it
   join it, and its pinches are opened. **A piece that comes within a ring of the lasso's edge is
   a feature the edge crosses, not work: it stays as it is** (the readout counts them; draw the
   lasso wider to take them). Walls gentler than about 35 degrees are a dish, not work.
3. **Each hole of work is filled locally.** The hole is small and the face round it is what it is
   fitted to, so a local height field along the face's own direction is enough *here*, however the
   whole patch curves: the ring of face round the hole (2.5 mm) is read as heights, a **thin-plate
   spline** is fitted through it (smoothed, so scan noise is not copied) and evaluated over the
   hole - it minimises bending, so a dome, a saddle or a groove goes on across the gap the way the
   face round it says - and the last mismatch with the hole's rim is carried inward over 1 mm. The
   hole is woven (`nso_cdt.js`, a constrained Delaunay on the rim's own corners) and laid on that
   surface. The result is the **cleaned patch**: the face, and what filled the holes.
4. **The cleaned patch is remeshed on its own surface** (isotropic remeshing, Botsch and Kobbelt):
   edges over 4/3 of the pitch are split, under 4/5 collapsed, flips equalise valences toward 6,
   corners move along the surface toward their neighbours' mean and are put back ON the cleaned
   patch (nearest point), and the rim - every corner of a boundary edge - never moves: no rim edge
   is split, collapsed or flipped, and no edge is made between two rim corners that the mesh
   outside already joins (it would leave three triangles on one edge). Whatever the patch does -
   it does not have to unroll - it is the same surface.

**A piece that cannot be bridged stays as it is.** A hole whose outline folds over itself when laid
on its local plane is grown round the fold (three rings, up to eight times); if it still folds - a
finger web, a deep palm fold, which the creases class as work but which is the surface - it is kept
exactly as it is, counted in the readout (`N features cross the lasso's edge and stay as they are`),
and the rest of the patch is woven.

Follow skips 2 and 3. (An earlier version laid the whole patch as one height field along its mean
normal and refused anything that curled past about 75 degrees; a second tried unrolling the patch
conformally and weaving in the plane - it fails on a saddle, where the flattened outline overlaps
itself, and took 30-60 s on a palm-sized patch. Remeshing on the surface has neither limit.)

## What it refuses, in words

- `nothing is selected`, `the selection is the whole piece - there is no rim to cut along`, `the
  selection touches itself at N corner(s)`, `the cut runs along an edge three triangles share`.
- `there is no face left round the work in this selection - make the lasso larger, so its edge
  falls on clean face`.
- `a hole of work folds over itself when laid flat ...` - a hole whose outline, laid on its local
  plane, overlaps itself (the work is too tangled with a steep wall): use Follow, or a lasso that
  leaves it out.
- `that patch would need about N triangles at a pitch of P mm - raise the pitch`.
- **Paint stands it down.** A new patch renumbers triangles and paint names its faces by axis and
  side, so any paint on the piece stands Weave down, naming the count (the same rule as Text:
  `PAINT SCOPE: WHOLE-PIECE`).

## Results

| piece | cut | result |
|---|---|---|
| fixture: a jittered slab under a R30 cap, four strokes and a ring engraved 0.6 mm | a 13.6 mm circle, 11,200 triangles | new corners within 0.002 mm of the cap the engraving was cut from (rms 0.0007); the app's checker finds the piece exactly as closed as it was; edges 0.30-0.43 mm round a 0.36 pitch, angles p1 39 / p5 49 degrees |
| fixture: a R14 cap leaning 40 degrees at the cut's edge, a groove 1.2 mm deep through the engraving | a 9.2 mm disc | closed as before; new corners within 0.0027 mm of the true surface unengraved (a clone of the dome and the groove), and with the engraving in the groove's bottom within 0.14 mm (rms 0.016) |
| `text_repair_test.3mf` palm: DUKE DOKS, 148,578 triangles, self-piercing shells | a 7 mm disc: 12,330 triangles | 3.5 s; open 0, non-manifold 0, flipped 0, degenerate 0; piercing pairs 2544 -> 164 (the old skin was where they were) |
| the same palm | a 12 mm disc (28,000 triangles, over the finger webs), and a 15 mm one (41,000) | text gone, the palm and the webs cloned; 7 s and 11 s; closed, nothing non-manifold or flipped (the old engine refused both: "curls round too far to lay flat"); 22 and 29 features the disc's edge crosses (palm folds) kept as they are |
| the real page, a loop drawn FLAT on the screen round the text on the curved palm | 15,159 triangles | 113 mm² of work 0.87 mm deep bridged, 7 palm features at the edge kept; closed, piercing 2544 -> 166 |

## Against Text > Remove (docs/RESURFACE.md)

Text > Remove finds the work for you (rays down a box, walls cut the height field) and drops the
skin triangles whose centre stands over the work and a margin. Where the rim of that hole is noisy
(a scan's splinters and folds) it falls back to zipping a strip to a clean outline, and the new
triangles are 1 mm ones refined where the surface sags. Weave leaves the cut to you, so the rim is
where you put it; the new patch is an even weave at the mesh's own size; and the join is exact
because it is by construction, not by a fallback.

Measured on `text_repair_test.3mf` (`NSO_Resurface.scan` over the palm: 10 pieces of work, the
checker closed in every case):

| | Text > Remove | Weave |
|---|---|---|
| the whole word | all 10 pieces at once: refused, *"the outline could not be closed (the letters could not be triangulated cleanly (a flat or turned triangle))"* | one lasso: done |
| a piece at a time | 9 of 10 apply; the 10th is refused the same way | - |
| the new triangles' edges (the mesh's own: 0.17 mm) | p50 0.37 to 0.71 mm, p95 1.0 to 2.8 mm | p50 about 0.17, p95 about 0.21 mm |
| the new triangles' angles | 1st percentile 0.3 to 1.8 degrees (slivers) | 1st percentile 16 to 26 degrees (a few slivers survive at the rim, where the rim's own spacing is fixed), 5th percentile 45 |

## Not yet

- A pitch that changes across the patch (finer at a feature).
- Keeping the plate: the old patch as a piece of its own (as Crop copies a region out).
- Silhouette: a lasso takes what faces the camera; a patch that wraps round a limb needs two views.
- X-ray: the app drops X-ray on any bake's new mesh (`applyXrayView` is nested in app-join.js, so
  `updateAdjustUI` never reaches it - true of Text, Brush and the rest too); Weave puts it back
  itself after REATTACH (`NSO_weaveKeepXray`). A one-line export of `applyXrayView` would fix it
  for every tool; that is a behaviour change for all of them, so it is not made here.
