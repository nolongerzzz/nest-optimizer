## Wheel: live sliders - the piece answers while the slider moves
`app-wheel-live.js` (new), the Wheel card rebuilt in `index.html`,
`NSO_wheelApply` / `NSO_wheelBaseOf` / `NSO_wheelRanges` / `NSO_wheelPullClamped` /
`NSO_wheelReball` in `app-wheel.js`. Write-up: `docs/POTTERY-WHEEL.md` "Live
sliders".

What it is: every number on the Wheel card is a slider with a number box and a
read-out (the house `app-live-slider.js` pattern). Drag = a live preview of the
piece itself, nothing committed; let go = Set, one Undo step; type and Enter =
Set; Escape = put it away. Thick (Flatten), Deep (Open), Trim, Rim +, and H R W N
(which resize the ball while it is untouched) are all live; Pull is a moveable
ghost. A slider that cannot do its move is disabled with the reason as its
tooltip. Every existing id was kept.

Why Pull is a ghost, and why that was not enough: Pull "often failed". With the
clay conserved a pressed disc has zero headroom, so every outward pull needed
clay that did not exist (and every inward one silently destroyed some). A ghost
alone would only have shown the refusal sooner, so Pull also **conserves**: the
volume a pull adds or takes comes out of or goes into the height (every z scaled
about the base by V0/V1, exact), and `NSO_wheelPullClamped` stops at the largest
pull the wall and height allow and says what stopped it. The ghost is blue when
it is all of what was asked and amber once stopped.

Things a later ticket should read before touching this:
- **`conserve` is opt-in on `NSO_wheelPull`.** The strict API still pins the old
  ceiling behaviour (tests in section 4/7b/7d); the Wheel's button and ghost pass
  it through `clamp: true`. Flipping the default is the "Direction" step 4 cleanup,
  and Open still does not conserve.
- **The preview never touches the piece.** It swaps the placed mesh's geometry
  (Pull's own mechanism) with its bottom kept where the real bottom is; `end()`
  puts it back. Anything real (a move, a new ball, Escape, the menu closing, the
  300 ms watch noticing the piece moved) ends it first through `NSO_wheelUI`.
- **A refused preview leaves the last good form on screen** (swap) or drops the
  ghost (Pull), and the read-out says why in red.
- **The slider range of Rim + is not what it can do.** It needs a straight wall, which
  the buttons still cannot make; the slider will show the refusal. Pull's swing is
  half the widest radius, which the standard bowl's wall takes whole - the box can be
  typed past it, which is how the clamp is reached.
- **A single-point Pull is still a narrow bump** (falloff about a tenth of the
  height). A big one is a flange. A falloff-width slider or a drag along the
  silhouette is the next thing Pull wants.
- The card is long (the Gen+ body scrolls: 1126 px of content). Grouping or hiding W/N
  is a design question, not done.

Test changes worth knowing: a headless sequence pulled at z = 0.7 x the *ball's*
height on an opened piece half that tall - a silent no-op the new refusal exposed -
and now pulls inside the piece; wire section 4's "gained material" is now "clay
conserved, height gave it up"; section 1b's "piece gone" accepts either message
because the watch ends the session at Undo time.

`npm run wheel` (169 checks, was 135; section 7d is the new geometry) and
`npm run wire:wheel` (a new section 10c: drag is live and uncommitted, release is one
Undo step, drag again re-presses, Undo and Escape, Deep adjusts, the Pull ghost and its
amber clamp, H resizes a pristine ball and then only sets the next one, sliders off
with nothing on the wheel).
