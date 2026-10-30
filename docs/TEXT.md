# Text

Type a word, click a face of a piece, get it engraved there - any depth, any
size, a font from the list or one loaded from a file. The geometry is
`nso_text.js` (THREE-free, node-tested: `npm run text:test`); the card is
`app-text.js`, the **TEXT** button on the left bar between SHAPE and PAINT
(driven: `npm run text:drive`).

Open the TEXT menu and Text is armed: the menu is the card, there is no second
button inside it. Close the menu (or Escape, or Cancel) and it is put away.

## The card

| field | |
|---|---|
| text box | what to stamp; Enter starts a new line (up to 200 characters) |
| Font | Sans, Serif, Mono, Heavy, Script - the machine's own faces by name, with the usual fallbacks - and **Font file**: a `.ttf`, `.otf`, `.woff` or `.woff2` read in the page (`FontFace`, nothing is uploaded) and added to the list under its file name |
| Bold, Italic | the canvas's own (a face without them is synthesised) |
| Size | the height of a **capital letter**, mm (0.5 to 500). Lines are 1.2 em apart |
| Depth | mm below the surface, **square to the surface** (0.1 to 50) |
| Angle | degrees, counter-clockwise seen from outside; 0 reads along the face's longest straight edge |
| Mirror | read backwards, for a stamp or a mould |

STAMP cuts it, in one boolean and one Undo (`textReplace`); the card stays open
for the next face with its numbers kept. While it is open:

- a click on a piece lays the text there, centred on the click; a **ghost** of
  the very cutter STAMP subtracts is drawn through the piece (amber, the floor
  outlined; red when refused);
- **drag** the text (a press inside its box) to move it across the face, in 0.1 mm
  steps; the **arrows** nudge it 1 mm the way the arrow points on screen, Shift
  0.1; a press on a piece elsewhere moves it there; a press on the bare plate
  still orbits;
- Escape puts a drag back; Escape in a field leaves the field; otherwise it closes
  the card. Opening another menu, or arming Carve or Paint, puts Text away too (one
  click-owning tool at a time).

## Remove

The switch at the top of the card, **Stamp | Remove**. In Remove, click the floor
of an engraved letter: the ghost turns green and shows what will be put back,
REMOVE fills it flush with the face (one boolean, one Undo, `textReplace`).

It keeps no record of the stamp, so it works on text stamped in an earlier
session, after other edits, and on any recess in a flat face (a blind hole
included: a recess is a recess). `NSO_Text.pockets` reads it off the piece: a
click on a floor - or on a wall, the triangles within 3 mm are tried - seeds a
flood across the facets within a degree of it and in its plane (the floor), then
the triangles square to it that rise above it (the walls); the patch's open edges
are the **rim**, chained into loops. It is a recess only if the rim sits in one
plane (0.02 mm) above the floor and every triangle round it is a facet of the
face, not another step. `NSO_Text.fillers` makes a prism of each rim outline from
0.05 mm under its floor to the face's plane; the shipped union with the piece
closes it (the walls are coincident faces and the kernel takes them: three
stamped letters came back to the slab's volume to the last digit).

- **Whole word** (on): every recess whose floor and rim are in the same planes (0.03
  mm), within **Reach** mm of one already chosen (single linkage), so a word goes in
  one click and a second stamp of another depth is left alone. Off: the one clicked.
- Refused in words: not a recess (a plain face, a bump, a cylinder), a rim that is
  not flat (a recess in a **curved** face, or one a later Thicken / Scale has bent),
  a painted piece.
- The recess must still be a recess: **Thicken out** offsets every outer face,
  walls and floors included, so letters it has grown into are not recesses any
  more - Undo it, then Remove. The Check card's thin-wall count of text this small
  is the tool saying the strokes are thin, not that the text is gone.

## From a font to a cutter

1. **The picture.** The page draws the lines in the chosen font on a canvas at
   about 16 px a mm (no side over 4096 px; the resolution falls to fit) and
   hands its alpha to the engine. The canvas knows every font the machine has,
   which is why no font is bundled; the engine knows nothing about fonts.
2. **The outline** (`NSO_Text.shape`). Marching squares on the 128 contour of the
   alpha, the crossings interpolated so an edge is good to about a tenth of a
   pixel (0.006 mm at 16 px/mm); Douglas-Peucker at 0.35 px, after which every
   loop is checked against every other and itself and any that folded over (a
   hairline thinner than the tolerance) is redone at half, down to the traced
   loop; repeated points, straight-through points and zero-width spikes are
   taken out. Outer loops counter-clockwise, holes clockwise, each hole filed under
   the smallest outer loop that holds it, so an `O` with a dot in it is two
   polygons. The result is in mm, y up, centred on the middle of the ink.
3. **The triangles.** Ear clipping, the holes bridged into their outer loop
   (Eberly's rightmost-vertex bridge). A polygon's triangles must add up to its
   own area or the text is refused - a bad triangulation never reaches the kernel.
4. **The surface under it** (`NSO_Punch.surface`, Punch's frame and probe): the
   click's smooth surface (triangles joined across edges of at most 30 degrees),
   n its smooth normal at the click, u along its longest straight edge, v = n x u,
   and `foot(p)` for where the line through a point of the tangent plane along n
   meets that same surface.
5. **The cutter.** A prism along n: a flat top 0.2 mm over the highest surface
   under the text, vertical walls, and a **bottom that follows the surface** -
   each vertex of the text's triangulation sits `depth / cos(lean)` below the
   footprint under it, `lean` the surface's angle from n (never more than 2x), so
   the engraving is one depth all over a cylinder or a dome, not a flat scoop. On
   a flat face the triangulation is left alone and the bottom is flat. On a curved
   one it is refined by longest-edge bisection until no edge is over 1 mm (a
   bottom that is straight between vertices a mm apart is within a hundredth of a
   mm of the true offset on a 10 mm radius). The cutter is a closed solid wound
   outward by construction: top, bottom reversed, and a wall quad under each
   outline edge.

## Refused, in words, the piece untouched

- **it runs off the face**: any point of the text with no footprint on the click's
  own surface (the face ends, or it steps onto another one). Says how much of the
  outline and the text's size. A text that hangs over the edge of a boss is
  refused, not cut into the boss's side.
- **a wall under it thinner than the floor**: two nozzle widths (0.8 mm at 0.4)
  must be left under the deepest point, measured along n. Says how thin the wall
  is and how deep would fit: `the wall under the text is 6.0 mm at its thinnest;
  5.5 mm deep leaves 0.5 and the floor is 0.8 (two nozzle widths). At most 5.2 mm
  deep fits.`
- numbers that are not numbers (depth, angle, size), no ink, a click not on the
  piece, text too big to draw or to mesh.
- **a painted piece** stands STAMP down, naming the count (whole-piece paint scope,
  below).

A refusal still carries its cutter: the page draws it red so the text can be seen
where it would have gone.

**Said, not refused:** strokes thinner than a nozzle width (`2 x area / perimeter`
of the ink under 0.4 mm) - the readout says they will not print.

## Paint scope

**WHOLE-PIECE** (`nsoMaskCount(m) > 0`; `app-text.js` header, the roster in
`docs/handoff/standing-rule-paint-wins-for-every-bake.md`, `tools/nso_paint_scope_test.js`).
The text is cut through whatever faces it meets, curved ones too, and paint names
its faces by axis and side, so any paint stands it down.

## Not in the first cut

- **Emboss** (raised text): the same cutter, unioned instead of subtracted, its
  bottom at the surface and its top `depth` above it. The engine's prism already
  has both ends.
- **Removing** text from a curved face (the fill's top is a plane; the stamp's floor follows the surface, the removal does not yet).
- **Wrapping** text across an edge or round a tube's whole circumference: the
  prism is straight along n, so text stops where the face's smooth surface does.
- **Letter spacing, line spacing, alignment, outlines of a font's own name list**
  (any installed family by typed name; today it is the five stacks or a file).
- A text sized in its own font's **em** rather than its capital height.

## Checks

- `tools/nso_text_test.js` (`npm run text:test`): the contour (a disc, a ring, an
  "i", a dot in an O; sub-pixel edges), the triangulation (letters, a row of holes,
  40 random stars), the refinement, stamping a flat slab (the cutter closed, its
  volume area x (depth + 0.2), the shipped subtract taking exactly area x depth
  out), angle and mirror, a faceted cylinder (every sampled triangle engraved
  within 0.03 mm of the depth, square to the surface), the refusals, and a plan on
  eight letters on a 128-facet cylinder under 4 s. The boolean is the shipped one
  (`tools/nso_csg_node.js`); every number is read off its output.
- `tools/nso_text_drive_check.js` (`npm run text:drive`): the real page, real
  mouse and keyboard, the browser's own fonts (a loaded DejaVu face included).
- Remove is gate 10 of `text:test` (the union restores the slab, an O's island, word vs one, refusals) and 7b of `text:drive`.
- a Text row in `tools/nso_pick_release_test.js`: armed, after STAMP and after
  Escape, a left-drag on the bare plate orbits.
