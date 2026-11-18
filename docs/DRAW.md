# Draw — draw on a flat sheet, then connect it to a piece

The column card that was **CONNECT** is **DRAW**. Draw is its main tool and
Connect its second step:

```
DRAW
[ Draw editor ]            a flat millimetre sheet: Pencil, Line, Rectangle, Ellipse
[ Connect to a piece ]     the drawing on a face, as a ghost, moved freely; Weld in / Cut in / Own piece
▸ Anchors on the plate     Connect as it was (docs/CONNECT.md), id for id
[ Reattach ]
```

| | |
|---|---|
| geometry | `nso_sketch.js` (`window.NSO_Sketch`, headless) — outlines, solids |
| editor | `app-draw-editor.js` (`window.NSO_DrawEditor`) |
| connect | `app-draw-connect.js` — a SOLO mode on the Assemble editor's stage (`NSO_AsmEditor.mode('drawconnect')`), as Step / Boss is |
| checks | `npm run sketch:test` (`tools/nso_sketch_test.js`), `npm run draw:drive` (`tools/nso_draw_drive_check.js`), `npm run draw:assist` (`tools/nso_draw_assist_drive_check.js`), `npm run draw:fill-area` (`tools/nso_draw_fill_area_drive_check.js`), `npm run draw:bead-side` (`tools/nso_draw_bead_side_drive_check.js`), `npm run draw:follow` (`tools/nso_draw_follow_drive_check.js`), `npm run draw:trace` (`tools/nso_draw_trace_drive_check.js`: trace, snap, where drawn, stretch, weld; `TRACE_STL=` / `TRACE_BLOCK=` run it on a piece of your own); screenshots to `tools/draw-out/` |

## Why

The owner's request (2026-11-16), with a Bambu Suite pencil and the current
Connect stroke side by side:

> Rename the CONNECT card to DRAW. Draw the main tool of the card, connect a
> second step. Utilize an editor like Bambu Suite uses for their pencil vs the
> current draw on the plate/piece so there is more freedom to the lines I can
> draw. Drawing line and Drawing fill … draw/fill different wall faces …
> Connect similar to the new assemble flow: apply drawing to piece(s), in
> isolation with ghost render before bake, with free movement for ease of
> placement, without being limited by plate clicks and orbit limitations.

Connect's freehand Draw drew where a ray from the pointer landed on the plate
or a piece, so a stroke could only go where the view reached, and orbiting
fought every stroke. Drawing now happens on a flat sheet; placing it happens
on a stage with the pieces alone and a ghost.

## The Draw editor

Laid out the way the pencil in a laser / pen tool is: settings along the top,
tools down the left, the objects on the right, a grid with rulers in the
middle. Millimetres, y up.

| tool | key | |
|---|---|---|
| Select | V | click to pick (Shift adds), drag to move, drag on empty sheet for a box, corner handles scale (aspect kept while the lock is on), arrows nudge 0.1 mm (Shift 1) |
| Pencil | P | press and drag: freehand, smoothed on release (thinned 0.35 mm, Chaikin twice with turns over 60° kept as corners, RDP to 0.03 mm). Ending where it began closes it |
| Line | L | click point after point; double-click or Enter ends it; a click on the first point closes it; Shift: 15° steps |
| Rectangle | R | drag (Shift: square) |
| Ellipse | E | drag (Shift: circle) |

Wheel zooms about the pointer, right/middle drag or Space+drag pans, F fits.

**Process type** — every object is a **Drawing Line** (the stroke given a
*Width*: a bead, a rib; a closed one is a ring) or a **Drawing Fill** (the area
the stroke goes round, solid). It applies to what is picked; with nothing
picked it is what the next object becomes. **Height** is how far an object
stands out of the face (blank: the drawing's own Height, on the right).

**Size and place** — W / H (lock: keep aspect), Rotate by (Enter), X / Y of the
pick's centre, Mirror ⇋ ⇵, Duplicate (Ctrl+D), Delete, Ctrl+A. *Scale line
widths* makes a resize scale widths too.

An object that cannot be made is **drawn red** and the readout says why: a fill
that crosses itself, a line folded onto itself tighter than its width. Connect
and Add to plate stay off until it is fixed.

The editor's history is its own (Ctrl+Z / Ctrl+Shift+Z); nothing on the plate
changes until **Connect** or **Add to plate**. The drawing is kept in this
browser (`localStorage` `nso.sketch.v1`, a convenience).

**Add to plate** makes the drawing a piece of its own, flat on the plate.

### Bead side

Where a Drawing Line's width goes from the path drawn (top bar, *Bead side*):

| | |
|---|---|
| **Centre** | the bead straddles the path (round ends) |
| **Left** / **Right** | the path drawn **is the bead's edge**, exactly — corners sharp — and the bead lies wholly to that side **on the screen, whichever way the path was drawn**: Right of an upright line is the screen's right, of a level line below it; Left of a closed one is inside. Its other edge is the path moved the whole width over (mitred corners), its ends square |
| **Off wall** (default) | as Left / Right, the side worked out per stroke: the one **away from the traced piece** (samples half a width either side of the path, inside the traced cut or not). Nothing traced beside it: Centre |

Follow a wall or a grid line with the cross-hairs and the bead's edge follows them.
**Flip** (X) puts the picked lines' beads on the other side; **X while drawing** flips
the line being drawn. A closed line with a side has the path as its outside or inside
edge.

At first Left / Right were the sides of the way a path ran, as the engine stores them
(`align`). The owner drew one line upward and the next downward, both Right, and got
the beads on opposite sides; the editor now turns the word over for a path drawn down
or leftward (`screenSide`), so the word means the screen's side.

**It bites the wall.** A path run along a wall's face *is* the face: a bead that only
touches the wall shares a face with it, and the weld refuses it ("would not be
joined"). So a bead whose edge side is the traced piece also reaches *Fill area
grows* (0.3 mm) back over the path, into the wall, where no one sees it; its far
edge is still exactly the width from the path (`bite` on the object,
`NSO_Sketch.edgeOutline`). Measured: a 1.2 mm Off-wall bead down a wall's face makes
the wall exactly 1.2 mm thicker.

**Corners of the walls.** On a traced piece whose walls meet through a fillet, the
Line tool also snaps (within 14 px, before anything else) to where the two walls'
lines cross — the sharp corner the fillet rounds off — so a path along one wall
turns onto the next exactly there.

### Furring a space solid: Guide + Fill area

The owner's case (2026-11-18): fill a channel of a bent sheet solid, with straight
faces meeting the walls — by hand on a grid that the walls run 10° off, impossible;
by crop-and-glue, a seam that would not seal (their glued attempt: 6 non-manifold
edges, 1 068 self-intersections).

1. **Guide** (Process type): a construction line — drawn dashed, snapped to, never
   built. With the **Line tool**, draw one across the mouth of the space.
2. **Fill area** (tool, B): click inside the space. It becomes a fill of exactly that
   space — found on a fine grid (≤ 0.1 mm), flooded out to the traced walls, drawn
   lines and guides — **grown 0.3 mm into the walls** (*Fill area grows*), so a weld
   bites solid material instead of sharing the wall's face. It **stops on a guide**:
   the bite never crosses one (nor wraps round the wall ends beside it), and that
   side is put exactly on the guide's line, stood **0.02 mm** past it (a face flush
   with the wall ends is coplanar with them: on a channel closed flush the weld left
   2 non-manifold edges; 0.02 out or in, none). A space open to the outside, or a
   click outside everything, is refused in words.
3. **Connect → Piece height → Weld it in.**

#### Follow edges, and closing small gaps

Hand-drawing a guide along a boundary that already exists — a traced fillet, a
bead's edge — leaves slivers and gaps whatever the assist does with the stroke
(the owner's screenshots, 2026-11-18). So the boundary is not redrawn, it is used:

- **Line follows edges** (on by default): two points one after the other on the
  same edge — the traced outline, or a line, guide or fill already drawn — are
  joined *along* that edge, round its fillets and curves, the shorter way round a
  closed one, **when that is plainly meant**: the way along it is no more than 1.5×
  the straight distance and turns no sharp corner (over 60°). A guide from corner to
  corner across a channel's mouth stays straight (it ran round the channel at first:
  `draw:fill-area` caught it). **Alt** held while clicking gives the other choice.
  The preview shows which before the click; the hint adds "follows the edge".
- **Fill area closes gaps** up to *closes gaps to* (0.5 mm): a line that stops a hair
  short of a wall no longer leaves the space "open". Its boundaries are thickened
  by half the gap, the space flooded inside them, and the flood let back out by the
  same half towards the true boundaries (never past a guide) — so away from the
  gap it still reaches the walls exactly. The hint says when a gap was closed.
- The ends of a pencil stroke, and the Line tool's edge snap, now land on drawn
  lines as well as the traced outline.

The recommended way to fill a pocket: draw the beads, then **Fill area inside the
pocket** — it hugs the traced curve exactly and bites *Fill area grows* into the
walls and beads round it (lower it for a smaller bite). Draw a guide only to cut
a space off, and let it follow the edges.

#### The fill's edge is exact; how much it has to bite

The grid finds the space; it does not draw its edge. Every point of the grid's outline
(a staircase a cell off the walls, which showed at 2000% zoom) is put back exactly:
beside a guide, on the guide's line, 0.02 mm past it; beside any other boundary,
exactly **bite** from it on the wall's side — so the fill's edge is the wall's own
curve moved bite into it. Where two boundaries that touch or cross meet, the point
goes where their two moved lines cross: a sharp corner, not a chamfer. A ring that
would still fold (two boundaries pulling a point both ways) has its spikes taken
out, and one the triangulation would not take falls back to the grid's outline.

Lines bound a Fill area **by their bead as built** (with a Bead side, the path is the
bead's outer edge: a fill bounded by the path bit past the bead).

**Can it just kiss the wall and weld?** No — measured on the owner's
`thicken_oneside.stl`, its channel filled at each Fill area grows:

| bite | weld |
|---|---|
| 0 (the fill exactly on the wall) | refused: "the two pieces do not touch" — two solids that only share a face have nothing to fuse |
| 0.05 mm | clean (mesh_validate: 0 open, 0 non-manifold, 0 degenerate, 0 piercing) |
| 0.1 mm | clean |
| 0.3 mm | clean |

The bite is inside the wall, so it does not show after the weld. The default is now
**0.1 mm** (was 0.3): the least with a margin over the 0.05 that held. At 0 the
refusal says to raise it.

#### The Line tool's snaps

First that applies: a **corner** (a traced corner, or a point of something drawn,
within 10 px); on a line held to a wall's angle, where it **meets** a traced edge or
a drawn line, within 24 px of the pointer — the point that stops exactly on the
wall; the **angle** — along a traced wall or square to it, within 4° (Shift: every
15° too, within 8°); the nearest point of an **edge** within 8 px; the 0.5 mm grid.
A yellow diamond and a word show which. The traced outline is simplified first
(collinear tessellation merged to 0.02 mm) so a long wall's corners are its real
corners and its direction one direction.

#### A tidy after the weld

Where a drawing meets curved or filleted walls the union can leave a few zero-area
triangles whose corners lie under 1e-4 mm apart: closed and manifold by the kernel's
own count, non-manifold by `mesh_validate.py` at its 1e-4 weld (clean at 1e-5).
Draw > Connect runs Check & repair's own pass (`NSO_Repair.commit`) on each weld or
cut, and keeps it only when it changed something and the volume did not move; the
status says so (`tidied 6 zero-area triangles`). Measured on the owner's
`thicken_oneside.stl`, its middle channel filled: 6 → 0, volume unchanged.

### Line assist

A hand stroke made clean (`NSO_Sketch.assist`). **Line assist** in the top bar:

| | a pencil stroke on release |
|---|---|
| **Off** | smoothed only, as drawn |
| **Straight** | straight walls: sharp corners, every side squared to the nearest 15° — or to a **traced wall's** own angle — within 7°; two sides meet where their lines cross |
| **Auto** | straight where it is straight, a **true arc** where it curves round (centre and radius fitted), smooth where it does neither; a closed stroke that is round all the way is a circle |

**Shift** held when you let go makes that one stroke Straight. **Clean up**
applies the assist (Auto when it is Off) to what is picked — for strokes already
drawn; Ctrl+Z puts them back. The hint says what it made ("2 straight, 1 arc").
The choice is kept in this browser.

How: the stroke is resampled evenly; a **corner** is where it turns more than
35° over a window either side (1.2 mm, or 5% of its size) — read off a copy
with the wobble averaged out, so a shaky curve has none. Each run between two
corners is fitted with a line (total least squares) and a circle (Kåsa). A run
that bends without a corner (a U, a J) has its straight ends peeled off first —
the longest start and end within 0.15 mm (or 0.8% of their length) of a line —
and the middle fitted again. In Straight, a run that bends is cut where it
strays farthest from its chord until every piece is within 8% of a line.

### Trace a piece

The sheet is seen from above. **Trace a piece** (right panel: pick it, *at* how
far above its foot to cut, **Trace**) lays that piece's outline under the sheet
— orange, with its foot and top dashed — in **plate millimetres**: x as the
plate's, y as the plate's from above. Points of the Line tool, corners of a
rectangle or ellipse and the two ends of a pencil stroke **snap to the traced
outline** (a corner within 10 px, an edge within 8 px; *Snap to the traced
edges* turns it off). The drawing is then in the plate's own coordinates, and
Connect puts it **where it was drawn** (below).

The owner's case (2026-11-16): a thin bent sheet (Thicken's output) whose wall
is to be **furred out** — a block drawn on the sheet against the wall, seen from
above, then stood up and welded on.

## Connect

The Assemble editor's stage, with the plate's pieces **as they stand** (the
mode asks `asPlaced`: one offset for every piece, so a drawing can run from one
piece onto the next).

0. **A traced drawing opens already placed**: on the plate under the traced
   piece, exactly where it was drawn (moved with the piece if the piece has
   moved since). Its foot is the plate the piece stands on; **Piece height**
   stands it to the piece's top. **Where drawn** puts it back there after a
   click on a face moved it.
1. **Click the face it goes on** — any face: a top, a wall, an underside.
2. The drawing stands on it as a **ghost** (green Weld, red Cut, amber Own
   piece), each object its own height out of the face; on a wall, up the sheet
   is up the wall (Step / Boss's upright frame). Move it freely:
   - **drag the ghost** anywhere on the face's plane — past the face's edge
     too, onto the next piece. A 0.1 mm step; Shift snaps to the face's centre
     lines and flush with its edges;
   - **stretch**: a white handle at the middle of each side of the drawing's
     own box — drag one and that side follows the pointer while the opposite
     side stays put (Shift keeps the aspect); or type **Stretch ↔ / ↕ %**. A
     line keeps its width when stretched. **1:1** puts scale and stretch back;
   - **arrows** nudge (Shift ×10), **[ ]** turn 15° (Shift 1°);
   - type **Offset** (from the face's centre), **Turn**, **Scale %**,
     **Height** (overrides every object's), **Lift** (off the face; negative
     sinks it);
   - a click on **another face** moves the drawing there, settings kept;
   - **Edit drawing** reopens the editor with this face's rectangle drawn on
     the sheet as a size reference; closing it comes back to the stage.
   The pieces it would reach are lit orange; the rest are dimmed, not hidden.
3. **Apply** — one Undo:
   - **Weld in** — unioned into every piece it reaches, sunk 0.4 mm into the
     face so the boolean bites solid. One piece: Step / Boss's
     `toolShare` / `commitShare`, the piece keeps its identity and does not
     move. Two or more: each piece's world soup is unioned with the drawing in
     turn (each step must shrink the sum — a drawing that does not reach a lit
     piece is refused by name) and one new piece takes their place through
     Connect's own `NSO_connectCommit` (`supportSwap`: one Undo puts them all
     back). **That is the connection.**
   - **Cut in** — the solid turned into the face (from 0.4 mm above it to its
     height below) and subtracted from every piece it reaches; the picked one
     must be cut.
   - **Own piece** — no boolean; the drawing as a piece of its own where the
     ghost is.

Escape steps back to the face pick; again returns to the plate. Return leaves.

### A top flush with the piece's

A block whose top is exactly flush with the top of the piece it is welded to is
stood **0.02 mm over it**, and the readout says so. Measured on the owner's
Thicken output (`thicken_oneside.stl`, 16 004 triangles, 15 155 of them
slivers, itself clean): the same block welded at the wall's exact height left
**2 non-manifold edges**; 0.02 mm *under* it left **32** (the cut runs through
the wall's slivers); 0.02, 0.05 and 0.1 mm over, and a block stopping mid-wall,
all came back clean. 0.02 mm is a tenth of a 0.2 mm layer.

## How a drawing becomes a solid (`nso_sketch.js`)

- **A line's outline** is its two sides, the stroke moved out by half the
  width: round arcs round the outside of each turn (15° steps), and inside a
  turn the two moved segments are cut where they cross (the little loop is
  removed — only loops shorter than `6r + 2` mm, so a real self-crossing is
  not mistaken for one). Round ends close it. A **closed line** is a ring: the
  outer side and the inner side as a hole; narrower than its width, it is the
  outer side filled.
- **A line that crosses itself** cannot be one outline: it is halved (more
  corners put on first when it has few) until each run is simple, the runs
  overlapping by about a width, and the caller unions them. A hairpin whose
  legs lie on each other is refused in words.
- **A fill** is the stroke closed; one that crosses itself is refused.
- **Solids**: each outline (holes by even-odd) triangulated by `NSO_CDT` and
  stood up from `lift − embed` to `lift + height`: bottom, top, a wall round
  every loop. Outline edges are cut to at most **2 mm** first — a long thin
  triangle is what the boolean slices into slivers (CONNECT.md's stations
  note). Closed and outward by construction, checked by signed volume.
- Objects whose boxes overlap are unioned together before anything else
  (`overlapGroups`, then `NSO_unionSoups`); objects apart are two shells side
  by side.

## Measured

`npm run sketch:test` — every kind (straight, bent, zigzag, hairpin, wave,
self-looping, square and elliptical rings, fills) closed, wound, no
degenerate triangle, from −embed to height exactly; a 40 × 2 line is
`(L·w + disc)·h`, a 30 × 20 fill its area × h, a 30 × 20 ring of width 2 the
outer square (round corners, to chords) less the inner; smoothing keeps a right
angle; refusals in words; centring, scale, mirror, lift, per-object height.

`npm run draw:drive` — two 30 × 30 × 10 boxes 16 mm apart, a 60 × 3 × 2 line
typed across them: one piece in their place, volume **18393.176 mm³ = 2 × 9000
+ the line above the faces + the 16 mm span hanging 0.4 below them**, to the
third decimal; `mesh_validate.py`: 0 open, 0 non-manifold, 0 degenerate, 0
piercing; one Undo puts both boxes back. A 10 × 4 × 1 fill cut into a wall
removes exactly 40 mm³ and the box does not move. Own piece adds 40 mm³ on the
box's top, the boxes untouched.

## PAINT SCOPE

The editor: none. Connect: **WHOLE-PIECE** on every piece a Weld or a Cut
changes (a boolean replaces every triangle); a painted piece is refused in
words (`toolShare`'s check for one piece, `painted()` for several). Own piece
touches none.

## What changed elsewhere

- `index.html` — `#menu-connect`'s summary reads **Draw**; the card's body is
  `#draw-card`: `#btn-draw-editor`, `#btn-draw-connect`, then the old card
  inside `<details id="connect-sec-classic">` ("Anchors on the plate"), every
  id kept; Reattach stays the last row.
- `app-connect.js` — the anchor picks are armed while the card **and** the
  "Anchors on the plate" section are open (was: the card); `NSO_connectCommit`
  takes an optional name.
- `app-asm-editor.js` — a mode may ask `asPlaced` (every piece where it stands)
  and handle keys (`key(e)`); the stage's keys stand down while the Draw editor
  is over it.
- `app-core.js` — undo label `drawConnectReplace`.
- Tests that drive the old card open its section first
  (`nso_connect_drive.js`, `nso_pick_release_test.js`; `nso_qa_tour.js`'s
  Cancel selects the shape first, which opens it).

## Not here (yet)

- **Curved faces.** The drawing lies on the clicked face's plane; on a curved
  face that is the clicked triangle's plane, so it stands off or sinks in
  away from that point. Wrapping a drawing round a curve is a later ticket.
- **Text and imported SVG** as drawing objects.
- **Node editing** of a drawn stroke (move one point of it); for now redraw it,
  or scale / rotate / mirror the whole object.
- **The old on-plate freehand Draw** (the Draw switch in "Anchors on the
  plate") is still there, unchanged; it may be retired once this has been used.
