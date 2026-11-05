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
- Works on a **plain box** (what `rawSolidBox` accepts), with Round or Bevel. Corners / Corners+edges say they have no edge to pick; a cylinder or any
  other piece says it is not a box. Paint still counts: an edge touching a painted-out face is left sharp.

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

## Checks

`npm run boxedges:test` (kernel: closed, volumes to the closed form, 400 random edge sets) and `npm run soften:edges` (drive: real clicks build the
D-piece, one Undo step, refusals, Pick edges off leaves the wrap as it was). Ad hoc, 6000 random extreme sets (R up to a whole face, up to 12 edges)
all closed with positive volume.

## Not here

Round / Bevel only; no Corners styles. Plain boxes only: a piece that is not a box (or has pockets) is not offered edge picking. Three picked edges
meeting at one corner mitre rather than blend into a ball as the whole-box wrap does.
