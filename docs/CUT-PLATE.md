# Cut: the whole-plate blade

The Cut card's Blade row has a fourth blade, **Whole plate**: one level blade
across the plate, on a height slider. **Cut** applies it to **every piece it
crosses, at the same height, in one step.**

It was asked for to shorten a plate of print tests. A support reference plate is
six pieces that each stand on the same 5 mm pillar, with the feature under test
at the top; every test print spends most of its time on the pillar. One blade
across the plate, one number, and every pillar is shorter by the same amount.

## The card

Press **Whole plate** in the Blade row.

- **Height** (slider + number box, mm above the plate). The slider runs from 1 mm
  to the tallest piece less 1 mm, so its end is never a position that cuts
  nothing. The number box takes anything and is brought back into the range.
- **Keep above** (the default): what is *under* the blade is cut away and the
  rest is set back down on the plate. Every piece the blade crosses comes out
  *Height* mm shorter, whatever its shape, and the feature up top is untouched.
  This is the "shorten the pillar" cut.
- **Keep below**: the same blade, the other way up. What is above it goes and the
  pieces keep their feet (the blade's height becomes the piece's height).
- A **readout** says what Cut will do before it does it: `WHOLE PLATE @ 5.0 mm -
  keep above: 6 of 6 pieces cut, 5.0 mm shorter (tallest 17.0 -> 12.0 mm)`, and
  names any piece the blade leaves alone.
- The blade is drawn as a level frame and a translucent sheet at the slider's
  height, across the plate and every piece, through them (as the per-piece blade
  is), with a yellow outline where it meets each piece it will cut - the cut
  face itself, on each piece's own plane - so the height can be judged against
  the pillars. It is a helper (nso-helpers.js): never picked, never exported,
  gone when the card closes.

With Whole plate on, the per-piece controls (Rotate piece, the mitre and bevel
dials, the position slider, the readout) stand down, and no piece needs to be
picked: the **Cut** button is live. A click on a piece still picks it, but drops
no blade. Pressing **Full blade**, **Sized blade** or **Notch** puts the
per-piece cut back exactly as it was.

## What it cuts, and what it leaves

Height is **mm above the bed**: a piece stands with its lowest point at its
`liftY` (0 on the bed, more for a piece Lifted or Seated on another), so the
blade is at that piece's foot + (Height - liftY).

A piece is cut only if the blade clears **both ends by 1 mm** (`MIN_CUT_SIDE_MM`,
the distance Cut itself demands of a side). Otherwise it is **left exactly as it
is** and the readout and the status line say why, by name:

| piece | why it is left |
|---|---|
| lower than the blade | `it is only 4.0 mm tall, lower than the blade` |
| lifted above the blade | `it stands 20.0 mm up, above the blade` |
| blade within 1 mm of its foot / top | `the blade is less than 1 mm up its foot` / `... from its top` |

## How it cuts

The planning is `nso_cut_plate.js` (THREE-free, DOM-free, `npm run cut:plate`).
The cut is the app's own: `cutOneSide` (app-cut.js: `rawCut`, then the check that
the cut face is exactly the section, capped once), in the piece's raw frame
(Z up - the frame height lives in) at `plane = zmin + Height - liftY`. A tube's
cut face is an annulus, its bore open. Keep above then moves the kept soup down
by the part that went (in float32, equal inputs giving equal outputs, so no two
vertices that met come apart), so the cut face becomes the new foot at the
level the old one stood on.

The piece is replaced **in place** (`NSO_sculptCommitRaw`, app-sculpt.js - the
commit Crop uses): its name, id, quantity and place stay. The material that is
kept does not move in x or z; where the kept part's box is centred differently
from the piece's (a cut that takes the widest part away), x and z are carried by
exactly that, and that piece's Undo puts its old pose back with its geometry.

**All or nothing.** Everything is planned, checked and cut in memory before any
piece is touched. If a piece the blade crosses cannot be cut - its cut face will
not close (an inside-out or open piece), or it carries painted faces, which a cut
would renumber (the rule Crop and Smooth keep) - the press changes **nothing** and
names the piece: `Whole-plate cut not made: tee carries painted faces ...  Nothing
changed.`

**A turned piece** (a pose a scene file restored, or one mid-gesture) is first
set - its turn written into its geometry, as every pose action does when it ends -
because the blade is level in the *world* and the cut is made in the piece's own
frame. That step joins the same Undo.

**One Undo** for the whole press (a `stepGroup` of each piece's own geometry swap,
as the Join card's presses are). Redo re-applies it. Redo, like every Redo,
closes the tools that have a helper, so the card closes and is opened again.

## Files

`nso_cut_plate.js` (plan, move, range), `app-cut-plate.js` (the card's fields,
the blade, the press), `app-cut.js` (the Blade row's fourth mode, the per-piece
blade standing down), `app-join.js` (`cutActiveModel` hands the press over),
`app-core.js` (a click on a piece drops no blade; the Undo / Redo labels, one
`UNDO_REPLACE_LABEL` row), `index.html` / `styles.css` (the fields and the
`cut-per-piece` marks).

Checks: `npm run cut:plate` (node: the plan, the cut on a T and a standing tube
through the real `cutOneSide`, volumes, closedness, the float32 move) and
`npm run cut:plate-drive` (real Chromium, 46 gates: the card, a real click, Keep
above / below, a lifted, a turned and a painted piece, Undo, Redo, the other
blades). `wire:cut-redesign` lists the card's controls and names the new ones.

## Not done

- One blade for the whole plate, level. A tilted or per-piece-height blade is the
  per-piece Cut's job.
- Only the active bed's pieces (the plate in view); another bed is its own plate.
- **Keep above** removes the bottom of every piece, foot included. To keep a foot
  and take a slab out of the middle of a column, use Crop on a piece (it removes a
  band and slides the far part back); a plate-wide band is the natural next step.
