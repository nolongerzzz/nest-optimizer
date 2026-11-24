# Soften, Pick edges - round or bevel just the edges you click

`nso_box_edges.js` (the kernel, headless) + `app-soften-live.js` (the card) + `softenCompute` in `app-finish.js`.

Soften's whole-solid wrap rounds all twelve edges of a box, or the edges between the faces left unpainted. It cannot say "just these two": an edge
rounds only when both of its faces do. **Pick edges** takes the edges themselves.

## Using it

Open Surface & edges > Soften, tick **Pick edges**, pick **Round** or **Bevel**. The box's twelve edges appear as white lines on the ghost. Click one
to pick it (it turns into an orange bar), click it again to take it off; **Clear** drops them all. Set R and the preview follows. Soften bakes it.

- R now goes to **15** (the box and the slider). Soften's other engines still clamp to their own wall limits.
- Each bake can use a different R and different edges. Edges picked on an earlier bake of the same run are **kept**, at the radius they were baked
  with; an edge picked again takes the new R. One Undo step covers the whole run and gives back the original box.
- The Anti-Wobble Desk Spacer's body is two bakes of a 30 x 30 x 50 box: the two long edges on one side at R 15 (a half-round the full width), then the
  two on the other side at R 3.
- Works on **any piece**, with Round or Bevel. A plain box (what `rawSolidBox` accepts) offers its twelve edges and is clipped exactly as below; any
  other piece - a wall with a notch cut out of it, a ledge, a step, a divider - offers every sharp straight edge it has (see *Not a box*).
  Corners / Corners+edges say they have no edge to pick. On a box, paint still counts: an edge touching a painted-out face is left sharp.

## How it is built

A box edge at radius R is the box with a quarter-round (Round: 12 chords per 90 degrees, the wrap's sampling; Bevel: one chord) in place of that
edge, along its whole length. Each such solid is convex, so the result for any set of edges is the box **clipped by the profile planes of every picked
edge** (`clip` in `nso_box_edges.js`: convex polyhedron against a half-space, the cut becoming a new face). There are no patches to stitch, so places
where picked edges meet need no case of their own: two edges that share a corner mitre; an edge that stops at a corner is cut square by that face;
parallel edges across one face may take the whole width, R = half is a true half-round and the flat between them is dropped.

Each edge has its own radius (that is what lets two bakes build one piece). Edges are numbered `axis*4 + sideA*2 + sideB` (see `NSO_boxEdgeFaces`).

**Radius fit.** Along each axis, the roll-off depth from the low face plus the depth from the high face must fit the box's width, or the solid pinches.
Where it does not, every edge touching that axis is scaled down together (`fitRadii`). A single edge may use a whole face; a pair across one face shares
it. Radii are cut to the micron, rounded down, so two radii that differ by less than that are the same radius; the status line says when a radius was
clamped. If a combination of full-width radii still touches itself, the kernel retries at 0.1%, 1%, 5% less (`build.shrunk`).

**Output** is snapped to 1e-4 mm, the grid `nsoSealScore` welds on, so what the seal test calls closed is what the geometry is.

## Not a box

`nso_mesh_edges.js` + `softenMeshEdges` in `app-finish.js`. The card draws every **line** of the piece: mesh edges whose two triangles bend more
than 20 degrees, chained while they run straight between the same two face planes. Each line is **convex** (an outside edge: the rim of a notch, the
top of a wall) or **concave** (an inside corner: where a notch floor meets its end, where a wall meets a floor).

- A convex line is rounded by **cutting away** a prism: the profile between the two faces and an arc of radius R tangent to both (Bevel: the
  chord), run along the line. A concave line is rounded by **adding** that prism - a fillet. Faces need not be square: the setback is
  R / tan(angle/2).
- **Ends.** Where the space past a line's end is outside the piece (cut) or inside it (fill), the prism runs on past it and the end face trims it, so
  a rim that runs out through the top of a wall is rounded all the way out. Where another picked line of the same kind meets it on a shared face,
  the two mitre on the bisecting plane (the U of a notch turns its corners without a step). Otherwise it stops square.
- **Fills first.** Inside corners are filled, then the lines are read again off the filled piece and each picked rim that ran into a fillet is
  **carried round its curve**, so a notch with its rims and its inside corners all picked comes out with the fillet's ends rounded too, not standing
  proud as fins.
- **Fit.** Each line's setback is held to 90% of half the width across each of its faces (a ray from the middle of the line), so a 2 mm wall takes
  at most R 0.9 from each side and two rims of one wall never meet in a knife edge. The status says when a radius was clamped.
- All the cuts are made one solid first and taken away in one boolean (likewise the fills), so prisms that meet on a mitre leave no sheet between
  them. The result is snapped to the seal test's 1e-4 grid and needle triangles of no area are dropped. If it still does not close cleanly the job is
  re-run 0.5%, 2%, then 5% smaller; if it never does, Soften refuses and the piece is unchanged ("try a smaller R").
- It goes through the boolean kernel, so the preview lands a moment after a change. Pressing Soften while it is still working bakes it when it lands.
- Edges picked on an earlier bake of the run are kept at their own radius, as on a box; one Undo step covers the run.

## Checks

`npm run boxedges:test` (kernel: closed, volumes to the closed form, 400 random edge sets) and `npm run soften:edges` (drive: real clicks build the
D-piece, one Undo step, refusals, Pick edges off leaves the wrap as it was). For a piece that is not a box: `npm run meshedges:test` (a notched 2 mm
wall and a 60-degree wedge: volumes to the formula, fills added, rims carried round fillets with no fin, thin-wall clamp, 40 random edge sets closed)
and `npm run soften:meshedges` (drive: a real click on the notch's rim, the whole notch, a second bake at another R, Undo, Soften pressed early). Ad hoc, 6000 random extreme sets (R up to a whole face, up to 12 edges)
all closed with positive volume.

## Not here

Round / Bevel only; no Corners styles. Three picked edges meeting at one corner mitre rather than blend into a ball as the whole-box wrap does.
On a piece that is not a box: only straight edges between flat faces are lines - a curved rim (a cylinder's) is offered as its short facet edges,
one click each; paint is not read; and very large radii on thin walls with many edges picked can fail to close and are refused.
