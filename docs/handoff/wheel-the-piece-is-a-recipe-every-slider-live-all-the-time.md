## Wheel: the piece is a recipe - every slider live all the time
`app-wheel.js` ("7g. THE RECIPE": `NSO_wheelBuild`, `NSO_wheelNewRecipe`,
`NSO_wheelSetRecipe`, `NSO_wheelOpenKeep`, `NSO_wheelStretchAbove`),
`app-wheel-live.js` rewritten around it, the Wheel card rebuilt in `index.html`.
Write-up: `docs/POTTERY-WHEEL.md` "The recipe and the live sliders".

**What changed and why.** The first live sliders baked each move into the piece on
release and then disabled the sliders that no longer applied (Flatten refused an
opened piece, Open refused a disc). The goal is to shape a piece into its final form
by sliders alone, so the piece is now a RECIPE: ball > press (Thick) > open (Deep) >
pull (Pull at / Pull / Soft) > trim > rim +, rebuilt from the ball whenever any value
moves. Nothing is baked, nothing is switched off, the order you move them in does not
matter, and any slider taken back to neutral gives the earlier piece back exactly.
Releasing a slider is still one Undo step; the recipe stays editable; Undo rewinds the
recipe (history entries are `{ recipe, piece, soup }`) and the sliders follow.

**A limit is a clamp, not a refusal.** `NSO_wheelBuild` does the most a stage can and
returns `notes` ("Deep limited to 7.1 mm", "Pulled 27.9 of 40 mm - stopped there because
the wall reached the nozzle floor", "Rim + needs a straight wall"); a Deep a 3 mm disc
cannot honour is remembered and takes effect when Thick comes back up. `ranges` come out
of the same pass because they depend on what is upstream.

**Open now keeps the clay** (`NSO_wheelOpenKeep`): the strict Open threw the top of the ball
away; this stretches everything above the cavity floor until the volume is what it was
(linear in the stretch, so exact; the base is untouched). Consequence worth knowing: with
a 3 mm wall the cavity spans the whole disc and the walls stand tall - Thick 30 + Deep max
is a jar, Thick 8 is a O104 x 40 bowl. W is the lever.

**Card:** Starter Ball first; no nozzle control; H R W Thick Deep, Pull at / Pull / Soft,
Trim, Rim +. Pull / Trim / Rim + buttons are gone (their sliders are the move);
Flatten / Open stay as one-click presets that send their own slider to its far end. The
Pull ghost is gone - the piece itself now answers every slider.

Things a later ticket should read before touching this:
- **The strict API still bakes.** `NSO_wheelRun(move, ...)` and the move functions are
  unchanged (the headless suites and section 3-9 of the wire test use them); a strict move
  makes its result the recipe's `base` and the sliders go neutral on top of it.
- **Rim + needs a straight wall**, which a recipe rarely has; the slider carries on and says
  so. Lip (docs "Direction") is the next move and fits as a stage after pull.
- **Open's cavity is as wide as W allows** - a narrow mouth wants its own control.
- **One pull.** Two bellies need a second Pull control, or dragging on the piece.
- A full rebuild is ~60 ms, fine for a live drag; Rim + calls Extend on a mesh and is the
  slow stage when it applies.

`npm run wheel` (194 checks, was 169; section 7e is the recipe) and `npm run wire:wheel`
(section 10b is the new real-app test: drag is live and uncommitted, release is one Undo
step, Thick after Deep re-presses and re-opens, order does not matter, a limit is a note
not a disabled slider, Undo and Escape, Pull taken back is exact, H resizes under it all;
sections 3-9 now drive the strict API).
