# Custom shape — an outline you draw, made into a tray, a frame or a solid

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
| **Whole piece** | Height, Floor (tray), **All walls**, **All radii** (set every side / corner at once; "mixed" when they differ) |
| **Add to plate** | bakes what the preview shows: one piece, one Undo |

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

A wall under **2 nozzle widths** (0.8 mm at 0.4) is made, with a warning; the
read-out always gives the **thinnest wall as built**, measured between the two
outlines.

## Not (yet) here

A fillet where the floor meets the walls; a draft (walls leaning out); a lip or
a lid; reading an outline off a selected piece or a picture. Each would be a
change to `make()` alone - the outline is already the part that is hard.

## Paint scope

None: the piece reads no face of anything and writes to no face. The selected
piece is read for its footprint only, to stand the new one beside it.
