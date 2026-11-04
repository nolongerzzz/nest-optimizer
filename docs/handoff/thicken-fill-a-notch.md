## Thicken - fill a notch: a click on a wall takes its side (2026-11-04)

Ticket: "fill some of the notch back up in this piece, using extend or thicken on
a selected wall, with a live preview before bake, like Thicken and Foam".
UI only, in `app-thicken-live.js`: **what Thicken computes is unchanged**
(`_thickenOffsetSoup` / `thickenSelectedModel`, `app-finish.js`, not touched).
Fixture: `fixtures/notch_u.stl` - 47 x 35.43 x 36 block, a U notch through all of
Z (26 wide, 29.43 deep, open at the front); the piece the ticket came with.

### What was wrong

Thicken's per-face pick already moved a notch wall - but only with **Thicken in**.
A notch, slot or pocket wall is an *inside* face to the engine (`_thickenClassifyOuter`),
so with **Thicken out** armed a click on it read "the wall you picked is on the
inside - Thicken in moves it", and Set stayed greyed. Nothing on the panel said
that "in" is the verb for a notch. And the slider stopped at 8 mm; the notch is 26.
(Not Extend: Extend is the axis-preserving stretch of `app-extend.js` - it
lengthens the piece, it does not move one wall into a gap.)

### What it does now

1. **The click takes the wall's side.** Both verbs only ever add material to the
   wall; the wall says which one can. A click on a wall whose side is not the armed
   verb's flips the verb (button lit, status line: "Thicken in - that wall faces a
   notch or pocket, so it grows into the gap") instead of refusing. A verb button
   pressed *by hand* with a wall already picked keeps the engine's refusal - that
   is the person choosing, not the click.
2. **The slider runs to the piece's size for a picked wall** (47 here, capped at
   200), and back to 8 for the whole piece / Cancel / Set. The engine is still the
   limit: past the far wall it refuses in its own words ("40 mm is more than the
   feature it grows into (8 face(s) would turn inside out)"), and Set greys. On the
   fixture: back wall to 29.4, side walls to 25.9 (the notch is 26 wide).
3. **The ghost carries the slab.** Besides the green faces where the moved ones
   land, the material the wall would add is drawn as a solid (`drawSlab`): the wall
   patch's *boundary* edges swept from where they stand to where they land, so a
   wall of many triangles has no sheets inside it. Translucent green, outlined.

### Gate

`thicken:drive` section 11's "wrong side is refused" became "the verb follows the
wall" (and gained "a verb pressed by hand still refuses"); section 13 is new, on
`notch_u.stl`: click the back wall with Thicken **out** armed -> Thicken in, slider
max 47, slab present and 12 x 26 x 36; 40 mm refused in words with no slab; Set is
the ghost bit for bit; 24 corners moved, all on the back wall, all 12 mm toward the
front; volume grew by exactly 25.996 x 36.004 x 12 = 11231.567; Undo is the
original; the left wall with Thicken in, 20 ok / 26 refused; Cancel leaves no slab
and the slider back at 8.

### Not done / asked

- A fill that stops short of the whole wall (half the height of a notch, a corner
  block) is a *partial wall*; the wall is the engine's patch (coplanar, grown across
  creases under 45 deg), so it is all or nothing. A Cut first, then Thicken, is the
  way today; a "fill a region of the wall" is a different tool.
- The ghost still draws the stretched neighbours (the notch's floor and ceiling at
  the wall's edge) in green with the wall; they are faces whose corners move, and the
  engine says they do.
