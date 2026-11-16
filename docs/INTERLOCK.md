# Interlock — keys and their sockets, on the assembly editor's stage

The assembly editor's second tab. One click names a face; a key stands on it —
a tongue, a round pin or a snap tab, sized by typed caliper values — and is put
exactly where it is wanted by dragging it on the face or by typing its
distance from any of the face's four edges. If another piece is seated against
that face, the matching socket is cut in that piece. Apply is one Undo, and
neither piece moves.

| | |
|---|---|
| solids | `nso_interlock.js` (`window.NSO_Interlock`, and a node module) |
| the tab | `app-asm-interlock.js`, registered with `NSO_AsmEditor.mode('lock', …)` |
| the card | `#btn-asm-interlock` on the Assemble card opens the editor on this tab |
| checks | `npm run interlock:test` (node, 54 gates) · `npm run asm:interlock` (the app, real clicks and drags) |

## Why

The owner's ask (2026-11-15), working on an X-axis lock for an A1 Mini — two
risers and a plate that fits over the tool head so a hand bump cannot move it
during maintenance:

> I would like a tool on the assembly card that allows me to create interlocks
> and pins similar to the ones in the model we just worked on between two
> pieces. It will need to allow exact placement by dragging, and caliper
> measurement input, so I can make custom interlocks between different prints
> and other physical items.

The model's own interlock, read off its file: each riser's hood has a
25.2 × 5.2 mm slot and the plate has 25 × 5 × 2 mm tongues — **0.1 mm of
clearance a side**. Those are the tab's defaults.

Chosen in the session: **mate first, then interlock** (the editor's Mate tab
Places one piece on the other; this tab finds what is seated on the clicked
face), and three shapes for a first version: tongue and slot, round pin and
hole, snap tab.

## Using it

1. **Click the face it goes on.** Every piece is on its own on this tab's
   stage — also two that are seated together — so the face *between* them can
   be clicked.
2. Now only that piece is in sight, with whatever is seated on the face drawn
   see-through where it really sits. The panel says which:
   *"Top is seated on it — cut the socket in it"*, ticked; or *"Nothing is
   seated on this face, so this makes the key only."*
3. **Make**: *Key here* (the key stands out of the clicked face, the socket
   goes into the seated piece) or *Socket here* (the socket goes into the
   clicked piece, the key onto the seated one, pointing in).
4. **Shape and size**, in mm, as a caliper reads them:

   | | fields |
   |---|---|
   | Tongue | Length × Width × Height, Ease |
   | Pin | Diameter × Height, Ease |
   | Snap tab | Length × Width × Height, Ease, Catch |

   **Height** is how far the key stands proud of its own face. **Ease** is a
   45° chamfer round the tip. **Fit** is clearance per side: the socket is the
   key grown by it on every side wall, and deeper than the key is tall by the
   same. **Socket goes through** cuts it out the far side.
5. **Place it.** Drag the key on the face — the view does not turn under a
   drag, and the key is followed *through* the seated piece. A dragged key
   lands on the face's centre line or flush with an edge when dropped within
   0.75 mm of one, and otherwise on a 0.1 mm step. Or type: **a, b, c, d** are
   the distances from the key to the face's four edges, each drawn on the
   stage as a line with its letter, and a typed distance is exact — not
   snapped. **Turn** is degrees on the face.
6. **Apply.** The stage goes back to step 1 for the next one; sizes stay.

For something that is not a print — a slot in a machine, a bought part — click
the face with nothing seated on it and make the key (or the socket) alone, to
the numbers the caliper gave.

## The three shapes

Built in the key's own frame (x along the length, y across, z out of the face,
z = 0 on the face), closed and outward-wound — checked by signed volume as
each is built, not assumed.

- **Tongue**: a stack of rectangles — the bar, then a frustum for the ease, so
  all four top edges are eased.
- **Pin**: the same stack on a 64-sided circle.
- **Snap tab**: a tongue with a 45° ridge down each long side, `catch` proud.
  Its section is drawn once and run along the length (so its ends are square
  and only the long top edges are eased). The ridge is a triangle both ways —
  it rides in, and with a pull it rides out — so it prints either way up
  without support. It peaks `ease + 0.3 + catch` below the tip, and a snap
  must be at least `ease + 2·catch + 0.6` tall; shorter is refused in words,
  with the height it needs. The socket is the slot with the same two grooves,
  moved out with the wall.

Two numbers the user does not type: the key starts **0.4 mm inside** the piece
it is added to, and the cutter starts **0.2 mm before** the face it is cut
into, so neither boolean rests on a coplanar skin.

## Over a seat gap

"Seated" is: looking back at the clicked face, within 0.31 mm of it (the
widest seat gap and a hair) or 0.06 mm into it (the deepest overlap seat),
over its rectangle. Of several, the one with the most face there. The gap
found is carried through: across a 0.18 mm gap a 3 mm key reaches 2.82 mm into
the other piece, and the socket is `3 + fit − 0.18` deep.

## What Apply does, and reuses

- Both solids are carried into each piece's **own raw frame** through
  `app-mask.js`'s raw ↔ local mapping (a mirrored pose is detected by signed
  volume and wound back), and added / cut by the app's booleans
  (`NSO_unionSoups`, `NSO_subtractSoups`) — the route Attach takes.
- **Both are worked out before either is committed**, so a refusal on one
  leaves both pieces as they were. Refused, in words: a result that comes back
  open; a key that shares no volume with its piece (nothing under it to stand
  on); a socket that removes nothing; a painted piece.
- **The piece does not move.** `NSO_sculptCommitRaw` re-centres a piece's
  geometry on its own box, so a key out of one side would shift the body by
  half the key. The result's box is worked out in the world *before* the
  commit and the piece is put back to it after — x, z and liftY re-fitted,
  inside the same Undo entry (`prevPose`).
- A key that reaches **under the plate** (a key pointing down out of a piece
  resting on the bed) leaves its piece resting on the key; the other piece of
  the pair is raised with it, and the status says by how much.
- One press is one Undo (`stepGroup`), type `interlockReplace`.

## The editor now has modes

`app-asm-editor.js` was one tool; it is a stage with tabs. A mode registers
with `NSO_AsmEditor.mode(name, def)` and is handed the kit — the stage, the
session, `faceOf`, `markFor`, `asOneStep` … — rather than copying it, so there
is one definition of "the face under a click" for every tool on the stage. A
mode gets the stage's clicks, hovers, Escape and a first refusal on presses
(asked in the capture phase, so a drag it takes never turns the view). `apart`
asks for every piece on its own. Mate is the built-in mode and is unchanged.

## Measured

`npm run asm:interlock`, real clicks and drags:

- typed distances are exact to 1e-6, and the key's own box stands that far off
  the piece's edges;
- a drag moves the key, does not turn the view, lands on 0.1 mm steps, and
  lands on the centre when dropped 0.4 mm off it;
- **key alone**: +3 mm, body unmoved to 1e-5, checker clean, volume gained =
  the key above the face by hand (0.01 mm³), one Undo `===`;
- **pin hole**: removed = the 64-gon of radius 3.2 × 5.2; through = × 20, χ 0;
- **pair**: the slot is the key grown 0.1 on every side and 0.1 deeper;
  removed = 10.2 × 4.2 × 3.1; neither box moves; both pass the checker; one
  Undo restores both `===`;
- **0.18 gap**: socket 2.92 deep, removed = 10.2 × 4.2 × 2.92, the gap still
  0.18 after;
- **socket here on a pair**: the key hangs 3 mm down out of the seated piece;
- **snap tab**: both pieces pass the checker, volume = section × length.

On the owner's file (not committed — it is their model): the plate Placed on
the left riser's top, a ⌀4 × 8 pin typed to 2.00 and 1.00 mm from two edges →
`Pin ⌀4.00 × 8.00 added to Left; hole ⌀4.30 × through cut in Top, 0.15 fit per
side`; `mesh_validate.py` PASS on both (riser χ 2, plate χ 0 — it has a hole
through it now).

## PAINT SCOPE: WHOLE-PIECE

A boolean replaces every triangle on the piece, so there is no face this could
promise to leave alone. A piece with painted faces is refused in words, as
Attach refuses it.

## Not here

- **A face that is not flat.** The key stands on the plane of the clicked
  triangle.
- **Lead-in on the socket's mouth**, corner radii on a tongue, dovetails.
- **A one-way latch.** The snap tab is a detent — the same ramp in and out.
- **Checking the key against the rest of the other piece.** The socket is cut
  where the key is; a key that also runs into something else of the seated
  piece's is not looked for.
- **The a–d labels crowd each other** when two distances are under a couple of
  millimetres on screen.
