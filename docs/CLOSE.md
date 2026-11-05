# Close — a lid across an open end

ADD → **Close**. `nso_close.js` holds the geometry (headless). `app-close.js` is the card.
Tests: `npm run close:test` (headless, in `npm test`). `npm run close:shots` drives
the card in the real app and writes screenshots to `tools/close-out/`, which git
ignores. It is not a test step.

## 1. What it does

Pick an open end by clicking it: a tube end, an open box's rim, or any flat rim
with a hole in it. The opening's inner wall and the piece's outer wall pick it
too (section 2), so the 1.5 mm rim need not be hit. While the card is open, hovering outlines the rim under the
pointer in violet. A click picks it, outlines it in crimson, and shows the result
as an amber ghost. **Set** builds the lid into the piece. One **Undo**
(`closeReplace`) puts the whole piece back.

- **Thick**: the lid's thickness. It is filled with the wall at the picked rim
  and can be edited.
- **Inset**: how far below the rim the lid's top sits. 0 (the default) is flush.

The lid is unioned to the piece, and the result is one closed, manifold solid.
The piece's outside is unchanged: every triangle off the opening's wall is copied
bit for bit.

## 2. Reading the rim

The rim is the flat face under the click, edge-connected and in one plane. "In
one plane" is every vertex within 1e-3 mm of it or 1e-5 × the piece's bounding
diagonal, whichever is larger, so a float32 Cut rim (or a big piece's noise on a
skinny rim triangle) still reads as one face. Its boundary loops are walked with
Tube edge's walker. The outer loop
runs counter-clockwise about the face's outward normal and the holes run
clockwise. The hole nearest the click is the opening, and it can be any shape:
round, rectangular, a star.

The **wall** is measured in the face's plane:

- a round opening in a round rim: the difference of the two circles that
  `NSO_sectionFitCircle` fits;
- a rectangle in a rectangle: the narrower side's margin;
- anything else: the least distance from the opening's corners to the outer loop.

**Clicking the wall.** When the clicked face has no hole in it, the pick walks
from the clicked triangle, edge-connected, over the shell the click is on, to the
flat face with a hole in it that is nearest the click (the click's distance to
the face's triangles). It takes that face if it lies within one *wall-height* of
the click, which is how far the opening's wall runs down from that rim: to the
floor or step that ends it, or for a through-opening to the piece's lowest
point. So the inner wall and the outer wall of an open box pick its rim, down
to the height of the floor, and the box's bottom (farther than that) does not.
A tube's whole wall picks its nearer end. Two open ends equally near the click
are refused, not guessed at. The rim is read from its lowest triangle whichever
triangle was clicked, so the rim, the inner wall and the outer wall build the
same lid bit for bit.

**A through-opening** (a frame: the wall ends at the piece's lowest point, facing
away) is as deep as the piece is thick. The lid defaults to the rim's width but
is capped at that depth, so a frame gets a panel its own depth, flush both sides.

## 3. Building the lid

This is not a Boolean. The lid fills the opening's own wall between two planes
parallel to the rim, at depth `inset` and `inset + thick`, so the lid's sides are
that wall.

1. The wall's triangles above the lower plane are found by flooding from the
   opening's loop. They are cut at both planes, and the pieces between the
   planes are dropped.
2. Each cut point is computed once per (edge, plane), so both triangles on that
   edge share it and the cut needs no weld.
3. The cut's open edges form two loops. Each loop is closed with a flat cap,
   filled by ear clipping:
   - the lid's top faces out of the opening;
   - its underside faces into the opening.
4. With Inset 0 the top cap is the opening's own loop, so the lid's top meets the
   rim face at the rim.

A tube (Euler 0) becomes a cup (Euler 2). An open box (Euler 2) becomes a closed
box around a sealed hollow: two shells, Euler 4.

## 4. Gates and refusals

**Gates on the output.** If any of these fails, the piece is unchanged and the
readout says why.

- Every edge is used exactly twice, once in each direction.
- No triangle has zero area.
- The added volume lies between the two caps' areas × the thickness, within
  0.1%. For a straight wall such as a tube's or a box's, it equals cap area ×
  thickness.

**Refusals, in words, before anything is built:**

- "that edge isn't an open end — Patch repairs holes": the click is next to a
  hole in the mesh, or the piece has open edges anywhere.
- A click that finds no open end says what it read first: "flat face, 1 loop, no
  hole - this piece has no open end within reach", "... - the nearest open end is
  24.07 mm from the click, more than its 18.00 mm wall", "... - 2 open ends are
  15.00 mm from the click, as near as each other: click closer to the one to
  close". A loop that is a post standing on the face. A tangled outline.
- A lid thinner than 2 nozzle widths. A negative inset.
- A lid that would reach a floor, a step or the far side of the opening, with
  both depths: "opening found but the lid (8.00 mm) is deeper than the wall
  (3.00 mm, down to a floor)".
- Lid planes that cross more than one wall (a post or a divider inside the
  opening), or a wall that runs out to the outside.

## 5. Paint scope

**WHOLE-PIECE.** This follows the scoping rule in `docs/HANDOFF.md`. Close cuts the
opening's wall and the commit re-seats the whole piece, so it cannot promise that
any paint lands where it was. Any paint stands it down, and the message names the
count: `nsoMaskCount(m) > 0`.
