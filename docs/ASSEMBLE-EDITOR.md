# Assemble — one card, and an editor of its own

The Join, Seat and Align cards are one card, **ASSEMBLE**, in the column. On
top of it is **Open editor**: the plate's pieces alone on a stage, click the
face to attach, click where it goes, and a ghost shows the result before
anything on the plate moves.

| | |
|---|---|
| editor | `app-asm-editor.js` (`window.NSO_AsmEditor`) |
| commit | `NSO_poseApplyWorld` in `app-seat-surface.js` — Seat here's own commit, given a world matrix |
| weld | `joinSelectedModels({ inPlace: true })` in `app-join.js` — Complete Join, told the pair is already in place |
| card | `#menu-assemble` in `index.html`; `joinWireCard` (`app-join.js`) starts the Join session on it |
| check | `tools/nso_asm_editor_test.js` — `npm run asm:editor`, in `driveSteps` |

## Why

The owner's report (2026-11-15), with a real plate — two A1 Mini X-axis dust
covers and the two risers that stand on their ends:

> It's entirely too difficult to select pieces, and align, seat, or join them
> in a way that keeps a simple easy workflow. […] Cannot get a vertical join
> to happen and it's a lot of jumping between controls just to get things
> placed close enough for a join, or click the right faces.

Reproduced on that file through the real buttons, before any change:

| what was pressed | what happened |
|---|---|
| Join card, **Vertical**, A = cover, B = riser, gap off, JOIN | `Join ok (plate weld)` — and neither piece had moved. Complete Join does not read the toggle; because the two pieces' centres differ by more than 3.5 mm in height it took the "seated port" branch and bundled the two shells **where they stood**, 15 mm apart, as one piece. |
| the same with the A-B gap on | the riser is Center-locked onto the **middle** of the cover and seated there. Nothing on the three cards sends it to the end. |
| then Align edges | `Aligned into A's inner corner` — a 0.6 mm slide, still mid-cover. |

So the pieces to do the job existed, and the sequence that strings them
together did not: where on the face, which face of the piece, and the weld
were three cards and a guess.

## The card

```
ASSEMBLE
[ Open editor ]
Click the face to attach, click where it goes. …
[ Interlocks & pins ]                            (docs/INTERLOCK.md)
A key on one piece, its socket in the piece seated on it. …
▸ Join by slots      the Join card, id for id   (docs/JOIN-TRIPLE.md)
▸ Seat               the Seat card, id for id
▸ Align              the Align card, id for id  (it was in the top row)
```

Every control of the three cards is still here under its own id, doing what
it did; the three sections are `.vp-sec`, the Print card's sections, shut
until opened. Opening the column starts the Join session those sections work
in, as opening Join did. Shutting it is Cancel. Opening **another** menu
(Move, Rotate, Tip — to turn B before a seat) shuts the card and leaves A and
B standing, as opening Seat or Align used to.

Removed ids: `menu-joins`, `menu-seat`, `menu-align`. New: `menu-assemble`,
`asm-card`, `btn-asm-open`, `asm-sec-join`, `asm-sec-seat`, `asm-sec-align`.

## The editor

The editor is a stage with tabs: **Mate**, described here, and **Interlock**
([INTERLOCK.md](INTERLOCK.md)), which registers itself as a second mode
(`NSO_AsmEditor.mode`).

A stage of its own over the whole app, the way a slicer's paint mode shows
only the object being painted: no bed, no grid, no other tool's handles. The
pieces are spread out in a row, left to right as they lie on the plate, with
clear air between them, so no click meant for one lands on its neighbour.
Pieces that already stand together (boxes within 0.3 mm — wider than the
widest seat gap) are kept together, as they stand. Drag turns the view,
right-drag pans, the wheel zooms.

1. **Click the face to attach** — on the piece being put on. The whole flat
   face lights under the pointer. *Use its underside instead* takes the face
   the piece rests on without turning the view to reach it.
2. **Click where it goes** — on the other piece. Before the click, a **ghost**
   of the piece follows the pointer, already mated.
3. **Set it** — only the pair is in sight now: the piece it goes on, and the
   ghost.
   - **Position on the face**: a 3 × 3 pad — centre, flush with an edge,
     flush into a corner — read as the view has it, so the top-right cell is
     the corner that is top right on the screen. *Where I clicked* goes back
     to the click. Four arrows nudge by the step.
   - **Turn on the face**: quarter turns about the face it sits on.
   - **Gap**: the Seat slider's range and sign. Off is touching.
   - **Weld into one** or **Place**. One Undo either way.

Escape steps back one pick; again returns to the plate. *Return* leaves at
once. After a bake the editor is back at step 1 with the plate as it now is,
for the next piece.

### What the mate is

All of it is `solveMate()`, in world coordinates, on the pieces' world
triangle soups:

- **the face** a click names is every triangle of the piece in that plane
  facing that way (normals within about a degree, 0.05 mm of the plane) —
  joined or not, so the two feet of a channel are one face to stand it on;
- **its rectangle** is the smallest bounding rectangle of that face among the
  directions of the face's own longest edges, so a rectangular face turned
  any way on the plate still reads as that rectangle;
- **turn**: the part's face normal onto the reverse of the target's by the
  shortest turn; then about the target's normal by the least angle that lays
  the two rectangles parallel, plus the quarter turns asked for;
- **place**: where it was clicked, kept inside the face — so a click near an
  edge lands flush with that edge — and centred across a face it is as wide
  as or wider than; or the pad's edge / corner / centre; then the nudge;
- **gap**: off the target's plane by the gap.

The mate brings the two *picked faces* together and says nothing of the rest
of the piece. Two things are measured and said in the readout rather than
refused: the piece **hangs over the edge**, and **N mm of it stands past the
picked face, into the other piece** (a face picked in a recess — which is
also how a boss goes into a hole).

### What is reused, and not rewritten

- **The move** is `NSO_poseApplyWorld`, added beside Seat here's `seatPiece`
  and made of its commit half: the turn is baked into the piece's own raw
  triangles (the pose model cannot hold a free rotation), x / z / liftY are
  read off the box the move really produces, the position lock and the paint
  scope (whole-piece, only on the piece that moves, only when it turns) are
  Seat here's.
- **The piece it goes on** is settled onto the bed baseline first, as every
  Seat does, and the mate carried by the same delta.
- **The seat record** is `NSO_recordSeat`, as every Seat writes it.
- **The weld** is Complete Join with `inPlace`: the planar fuse and the plate
  weld stand down — both exist to *find or make* a mating, and this pair has
  just been given one — and the kernel union welds the two where they stand.
  The result stays where the two were instead of being parked at the midpoint
  of their plate positions. A caller that passes nothing gets the Join it
  always got.
- **One press, one Undo** is app-core's `stepGroup`, as the Join card's JOIN.

### Two things it does that were not asked for in so many words

Both follow from "the ghost is what you get", and both are said in the
status line when they happen:

- **Weld is off while there is an air gap.** A gap leaves two pieces by
  definition; the button's tooltip says so and Place is the action.
- **A mate that would hang the piece under the plate raises the piece it goes
  on** by exactly that much (its `liftY`), inside the same Undo. Seat here
  refuses this case; in the editor the bed is not in sight, so the pair is
  kept as the ghost showed it and the status says `raised N mm`.

## Measured

`npm run asm:editor`, 81 gates, real clicks on real pixels:

- opening the editor moves nothing: every piece `===`, undo depth unchanged;
- the ghost is drawn on the hover; a click by a corner lands flush in that
  corner to 1e-6; the plate still has not moved;
- pad centre / four corners / an edge, nudge = 1 mm, four quarter turns come
  back round;
- **Place at −0.18**: underside 0.18 mm above the hull (2e-6), liftY 20.18,
  seat recorded, one Undo `===`;
- **Weld**: one piece, through `tools/mesh_validate.py`: 0 open, 0
  non-manifold, χ = 2, 0 piercing, 0 coplanar, volume = hull + bit; the same
  for a real mesh (`hinge_pip.stl`); one Undo, triangles value for value;
- a mate that turns the piece 90° bakes the turn and undoes value for value;
- the under-the-plate case raises by exactly the deficit.

And the owner's plate (not committed — it is their model), both risers, each
by its real underside (the view turned to reach it) onto its cover's top by
the far end, two clicks and Weld:

| | left cover + riser | right cover + riser |
|---|---|---|
| status | `Right welded onto A1 Mini dust cover Left - one piece` | `Left welded onto A1 Mini dust cover Right - one piece` |
| size | 32.2 × 111 × 82.9 mm | 32.2 × 110 × 82.9 mm |
| open / non-manifold | 0 / 0 | 0 / 0 |
| χ, piercing, coplanar | 2, 0, 0 | 2, 0, 0 |
| degenerate triangles | 0 | **1** |
| `mesh_validate.py` | PASS | FAIL (`degenerate triangles 1`) |

The one degenerate triangle on the right-hand piece is the kernel union's:
both inputs have none (268 slivers each, 0 degenerate), and the union of a
2 mm foot onto a face carrying 2000 triangles of embossed lettering leaves one
zero-area sliver on the seam. The solid is closed and manifold; it is the
same union Complete Join and Subtract use, and Check & repair is where a
sliver is taken out. It is reported here rather than swept into a tolerance.
Two Undos put all four pieces back.

## PAINT SCOPE: none in the editor; WHOLE-PIECE in the commit

`app-asm-editor.js` reads pieces and draws a ghost. Its one write is
`NSO_poseApplyWorld`, which carries Seat here's rule unchanged: whole-piece,
on the piece that moves, only when the mate turns it. The weld is Join's and
keeps Join's.

## Not here

- **A piece list / search on the stage.** Every piece on the active plate is
  set out; a plate of dozens is a long row.
- **Curved targets at an exact gap.** The mate is plane to plane. On a curved
  face the clicked triangle's plane is the target; Seat here (in the Seat
  section) still does the true-minimum-distance solve.
- **Fixing the Join card's Vertical + gap-off JOIN** (the first row of the
  table above). It is reported, not changed: the behaviour is pinned by
  `join:triple` section 13 as "Complete Join, as it was", and changing what
  an existing button does is the owner's call.
