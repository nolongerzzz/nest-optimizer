# Custom shape — an outline you draw (or copy), made into a tray, a frame or a solid, with a lip and a lid

`nso_custom_shape.js` (headless, THREE-free), `app-custom-shape.js` (the card), in
**Gen+ > Custom shape**. It makes a **new piece** on the plate, selected, beside
whatever was selected; it edits nothing.

```
node tools/nso_custom_shape_test.js          headless: closed meshes, areas and volumes against hand-worked figures, refusals
node tools/nso_custom_shape_drive_check.js   the real card: tiles, drags, keys, preview, refusals, Add to plate, Undo, Big
```

`npm run cshape`, `npm run cshape:drive`.

## What it is for

Odd-shaped inserts and holders that no primitive is: a console or door-pocket
tray with one corner swept off in a long curve, an L-shaped drawer bin, a
trapezoid that fits a tapered slot, a gasket frame, a spacer plate. Measure the
thing, put the points where its corners are, round each corner as much as it
is rounded, give each side the wall it needs.

## The card

| | |
|---|---|
| **Start from** | Rectangle, Rounded, Swept corner, L shape, Trapezoid, Hexagon - each tile drawn from the engine's own mesh |
| **Make it a** | **Tray** (walls and a floor, open top), **Frame** (walls only, open both ends), **Solid** (the outline filled) |
| **Outline** | the editor: millimetres, y up, a grid that refines as you zoom. **Snap** 0.5 / 1 / 5 mm or off; **Fit**; **Big** lifts the editor over the page (Esc puts it back) |
| **Point** (picked) | X, Y, **Radius** (outside; the read-out says the most its sides have room for), **Inner R** (blank = auto), Delete point |
| **Side** (picked) | **Wall** (this side only), **Curve** (how far its middle stands off the straight line, + out, - in), Add point |
| **Copy from a piece** | read the selected piece's outline (below) |
| **Whole piece** | Height, Floor (tray), **All walls**, **All radii** (set every side / corner at once; "mixed" when they differ), **Outline: Shrink / Grow** by a typed amount |
| **Lip** | None / **Out** (a flange round the top) / **In** (a rim round the inside of the top); Lip width, Lip height, **Chamfer under it** |
| **Lid** | No lid / **With lid** / **Lid only**; Lid (plate thickness), Plug (depth), Fit, Plug wall |
| **Add to plate** | bakes what the preview shows: the piece (and its lid, beside it), one Undo |

In the editor: **drag a point** to move it; **click** a point or side to pick it;
the **diamond** in the middle of each side is its curve handle - drag it out or
in; **double-click a side** to add a point there (on a curved side the new point
sits on the curve and both halves stay on the same circle, so nothing moves);
**Delete** removes the picked point; arrow keys nudge it (Shift x10);
**Ctrl+Z** steps the editor back. Drag the background to pan, the wheel zooms.
The editor's history is its own - nothing touches the plate until Add to plate.

The shape is kept in the browser (localStorage), so it is still there next
time the card opens.

## How the outline is made

Every side is a **primitive**: a line, or with a Curve a circular arc whose
sagitta is the Curve. Moving a primitive in by *d* is exact - a line moves
along its inward normal, an arc keeps its centre and its radius changes by *d*.

**The inside outline is every side moved in by its own wall**, so each side
keeps exactly the thickness it was given whatever its neighbours have.

**A rounded corner** of radius ρ is the circle tangent to both its sides: its
centre is where the two sides, each moved a further ρ in (out, at a turned-in
corner), cross; the tangent points are the centre's feet on the sides. One
function makes every corner, outside (sides at 0, ρ = Radius) and inside (sides
at their walls, ρ = Inner R), for line/line, line/arc and arc/arc alike.

**Inner R, auto**: at an outside corner `Radius - min(wall either side)`, floored
at 0 - concentric when the walls are equal, so the wall is even round the
corner; at a turned-in corner `Radius + min(wall either side)`, so even a sharp
notch gets a fillet of exactly the wall inside it. Type a number to override it;
**Inner R auto** puts it back.

The outlines are tessellated with chords at most **0.02 mm** off the true arc
(up to 96 per arc); the caps are filled with the repo's constrained Delaunay
triangulation (`nso_cdt.js`), so the top ring, floor and walls share every
corner and the mesh is closed. The piece is centred on its footprint and
stands on the bed, open side up.

## Measuring with calipers

Pick a side: its **Length** box holds its length **corner to corner** - between
where its neighbouring sides meet, as if the corners were sharp. That is what
calipers read across the outside of a box-like piece whatever its corner radii
(on a curved side, the straight line between its points). Type a measurement and
press **Enter** (or leave the box); a half-typed number is never applied. Beside
it, how the length changes:

| | |
|---|---|
| **stretch shape** (default) | the shape is cut across the side's middle and the far half pulled along the side: a box stays a box, an L keeps its notch, the swept tray's sweep stays where it is |
| **move end point** | only the side's end point slides along it |
| **move start point** | only its start point slides back along it |

**Prev / Next** step round the sides (or points), with the box ready to type
over - go round the piece with the calipers, one side at a time. Under Whole
piece, **Width** and **Depth** are the outline's overall size, outside to outside,
corners and curves included (not the lip): type one and the shape is stretched
across its middle until it measures exactly that. A stretch that would fold the
shape over is refused, saying how far it can go; Ctrl+Z steps any measurement
back.

Measuring a **pocket** for an insert: enter the pocket's own sizes, then
**Shrink** by the clearance you want.

## Lip

**Out** puts a flange round the top: the outline moved out by Lip width, its
corners concentric (radius + width), Lip height thick - so an insert can hang
on the edge of the hole it drops into. **In** puts a rim round the inside of the
top: the inside outline moved a further Lip width in - to keep things in, or to
take a lid. Under either, by default, a **45° chamfer** as wide as the lip, so it
prints standing up without support; turned off, it is a square step (an
overhang the lip's width). A Solid can take an Out lip (a flanged plug or
stopper) but not an In one. The lip's outline is drawn in the editor, dashed
green.

## Lid

A second piece, previewed and added beside the tray (or alone, **Lid only**, for
a tray already printed): a **plate** the size of the top outline - the lip's,
with an Out lip - Lid thick, and under it a **plug** that fits the opening with
**Fit** all round (0.25 mm is a printed slip fit). Under an In lip the opening is
the lip's. The plug is a ring **Plug wall** thick to save plastic, or solid when
the wall is 0 or the opening too narrow for a ring (a warning says so); a Plug
of 0 is a flat lid. The lid is made plate down, the way it prints.

## Grow / Shrink

**Outline: Shrink / Grow** moves the whole outline in or out by the typed amount
- its exact offset, still editable: each point goes to where its two sides,
moved, now meet; an outside corner's radius shrinks (grows) by the amount, a
turned-in one's the other way; a curved side stays on its own circle's offset.
Walls, height, lip and lid are kept. A shrink that would use a side up is
refused. The use it is made for: copy a pocket's outline, Shrink by the gap
you want, make the insert.

## Copy from a piece

Select a piece on the plate, open **Copy from a piece**: the piece is cut
**At height** (from its bottom; it starts half way up) and the cut is drawn in
the editor in **orange**, moving as the slider does. **Use** its outside, or its
biggest hole (the inside of a tray, a pocket, a ring). **Copy outline** replaces
the outline with the cut, read back as editable points to within **Detail**:

1. every edge is cut into pieces no longer than Detail, so a long straight side
   has points of its own to say it is straight
2. the **straight runs** are found - at least 3 mm, within half of Detail of one
   line, and bowing no more than the best circle's own leftover error (a short
   stretch of any arc is within Detail of a line; this tells them apart even
   when facets put an arc's points a little off it). Each run's ends are
   trimmed back to the points on its own best line, so the first bit of the
   fillet beside it is left to the fillet
3. each **gap** between two runs is a sharp corner (one point where the lines
   meet), or one arc tangent to both runs - a **rounded corner**: one point where
   the lines meet, with the arc's radius as its Radius, just as the editor makes
   one - or else a chain of arcs (least-squares circles, at most ~150° each) and
   short straight sides
4. a cut with no straight run (a disc, an ellipse) is a chain of arcs alone

A rectangle, a rounded rectangle, an L, a trapezoid, a hexagon and a tray's
hole come back as exactly the points and radii they were made from; a noisy
trace (±0.05 mm) still reads as clean rounded corners at Detail 0.3. Walls,
height, lip and lid are kept; Ctrl+Z in the editor brings back what was there.
The cut stays in orange after the copy, to compare.

Known limit: two curves meeting with no straight between them (a fillet running
into a long sweep) are read as curved sides, not as a corner radius - within
Detail and editable, just more points than the drawing they came from.

## Refusals and warnings

Each in words, naming the point or side by its number in the editor:

- fewer than 3 points; two points on top of each other; points that enclose no area
- a **radius its sides have no room for** - which side, how long it is, and how
  much each of its two corners could take as the other stands
- a **curve** bigger than its side is long, or a wall thicker than its curve's radius
- an outline that **crosses itself**
- **walls that meet in the middle** - the inside outline turns over on itself
- an **inside corner with no room** - including the one case the geometry
  cannot do: a curved side meeting its neighbour nearly in line with
  **different walls** on the two; moved in by different amounts the two never
  cross again (give them the same wall, or make the corner sharper)
- a floor as thick as the tray is tall (choose Solid)
- a lip wider than the opening, taller than the piece, or (In) reaching down past the floor
- a lid's plug deeper than the tray is inside, or with no room once the Fit is taken off; a lid for a Solid
- Copy: nothing to cut at that height, or no hole in the cut when Use is its inside

A wall under **2 nozzle widths** (0.8 mm at 0.4) is made, with a warning; the
read-out always gives the **thinnest wall as built**, measured between the two
outlines.

## How the mesh is made

Every outline of one spec - outside, inside, the lip's, the plug's - is built by
the same function, so each has the same pieces (a fillet, a side, a fillet...)
in the same order, and records where each piece starts. A piece is two
**stacks** of outlines, bottom to top, for its outside and inside surfaces: the
same outline higher up is a straight wall; a different one higher up is a
sloped band (the chamfer), stitched piece to piece; a different one at the same
height is a flat step (the lip's underside or ceiling). Then the bottom, floor
and top caps. Everything is built on the outlines' own points, so the mesh is
closed by construction.

## Not (yet) here

A fillet where the floor meets the walls; a draft (walls leaning out); a snap
or screw lid; a grip on the lid; an outline traced from a picture. A fillet
read back from a cut where two curves meet (above).

## Paint scope

None: the piece reads no face of anything and writes to no face. The selected
piece is read for its footprint only, to stand the new one beside it.
