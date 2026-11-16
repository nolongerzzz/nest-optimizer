# Step / Boss — an outline stood out of a face: a step, a boss, a ledge, a wedge

`nso_boss.js` (the solid, headless) · `app-boss.js` (the editor) · UI: **ADD >
Step / Boss** · tests: `npm run boss:test` (node), `npm run boss:drive` (drive)

## Why

The owner's ask (2026-11-16): "add a pop-out or step onto a wall, like the
risers have at the top … thicken a section of a wall at an angle, or generate a
custom shape onto the side of a face". Chosen: not on the Assemble card or in
Interlock (it is a manipulation, not a join) — its own editor on the ADD card,
"like assemble / custom shape together", ghost before bake.

## Using it

**ADD > Step / Boss** opens the editor: the plate's pieces alone on a stage.

1. **Click the face it goes on.** That piece alone stays in sight, the face lit.
2. The **green ghost** stands on the face where Apply will put it. Shape it:

   | | |
   |---|---|
   | **Outline** | **Rectangle** (Length × Width, corner Radius) · **Round** (Diameter) · **Drawn** (points on the face) |
   | **Height** | how far it stands out of the face |
   | **Ramp** | 0: a flat top. Above 0: the top rises out of the face at that angle from the thin end and runs flat at Height |
   | **Ramp starts from** | the thin end — Bottom (default), Top, Left, Right, as the face is seen |
   | **a b c d** | its distances from the face's four edges; a typed one is exact |
   | **Turn** | degrees on the face; +90° |

   **Drag** the ghost to move it (it lands on the face's centre line, flush
   with an edge within 0.75 mm, else on a 0.1 mm step). A click on the face
   puts it there.
3. **Apply** unions it into the piece: one Undo (`bossReplace`), the piece does
   not move. The stage goes back to step 1.

**Ramp is three shapes.** 0 is a pad or step. 45 with the thin end at the
bottom, on a wall, is a ledge whose underside is a 45° slope — the pop-out at
the top of a riser, printable without support. A Height the ramp never reaches
is a **wedge**: the wall thickened at an angle (the readout says "a wedge").

**Drawn outline.** The points stand on the face as white dots joined by a
dashed line. Drag a dot to move that corner (0.1 mm steps); click one to pick
it (yellow) and set its **Point R**, add a point after it (**+ point**) or
**Delete** it (three is the least). **Start from rectangle** puts them back on
the Length × Width corners. **Use Custom shape** takes the outline drawn on the
Custom shape card (Gen+ > Custom shape): its points and corner radii (straight
sides only; a curved side is refused with how to fix it).

On a wall the face's frame is turned upright, so **a** is the wall's top edge
and **c** its bottom.

## The editor is the assembly editor's stage, as a SOLO mode

`NSO_AsmEditor.mode('boss', { solo: { title, returnTo } , … })`. A solo mode
gets **no tab** on the Assemble editor; opened on it, the editor wears its
title ("Step / Boss") and shows no tabs, and Return gives the focus back to
`returnTo` (`#btn-boss`). One definition of "the face under a click", its
rectangle and its marks for every tool on the stage.

The add-and-commit path is the editor's too: `toolShare(piece, tool, op,
words)` and `commitShare(w, undoType)`, moved out of `app-asm-interlock.js`
(which now calls them) — the tool into the piece's raw frame, the kernel
union, its refusals (open result, no shared volume, painted piece), and the
commit that puts the piece back where its body was.

## The solid (nso_boss.js)

The outline (a rectangle or drawn points through `NSO_CustomShape.outline`,
so every corner keeps its own radius; a 64-gon for Round), counter-clockwise
and centred on its box. With a ramp, the crease where it levels off is cut into
the outline; one CDT of the outline is the bottom and — with every triangle the
crease crosses split along it — the top, each corner at its own height; a wall
joins them. Closed by construction, outward by signed volume.

- **embed** 0.4: the solid starts that far inside the piece so the union bites.
- **dip** 0.02: the ramp's thin end starts that far below the face, so the
  ramp crosses it cleanly rather than meeting it along an edge.

## Not done

Curved faces; a step that carries over a face's edge onto the next one; a
pocket (cut) of the same outline; a draft on the step's sides.
