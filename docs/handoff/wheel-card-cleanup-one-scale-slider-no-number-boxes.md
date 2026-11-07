## Wheel card cleanup - one Scale slider, no number boxes
`index.html` (the Wheel card), `styles.css` (`.wh-slider`), `app-wheel-live.js`,
`app-live-slider.js` (optional box), `app-wheel.js` (the Starter Ball handler).
Write-up: `docs/POTTERY-WHEEL.md` "There is nothing to type into".

**What changed.** H and R are one **Scale** slider (the ball's radius, 10-50 mm, the
standard ball is 25 mm; the read-out shows the diameter). **W (Wall) stays** - it is the
lever for how thin things press and open. Every number box on the card is gone: a slider
and what it says, nothing to type into. Each slider is one row (name, track, read-out;
Thick and Deep carry the Flatten / Open preset button as their name), so the card is 316 px
tall instead of over 1100 px of scrolling and Gen+ fits the window.

Things a later ticket should read before touching this:
- **`app-live-slider.js` now takes `box` optional.** Without it `value()` reads the slider
  and there is no box to keep in step. Hollow, Fasteners, Soften, Scale and Fittings pass a
  box and are unchanged.
- **Scale is `recipe.ball.ballRadius`** (the default-ball route in `NSO_wheelDefaultBall`).
  A target height (Pappus) is still `NSO_wheelBall({ height })` in the API and what the
  strict-API tests use; the card no longer offers it.
- **Typing is gone, so is the typed-then-click dance** (`NSO_wheelJustSet` went in the last
  ticket; the change-on-box-blur path went with the boxes).
- **A selector trap:** `.vp-wheel` is a class Fittings and Fasteners' card bodies share. Any
  test scoping to "the wheel card" should use `#btn-wheel-ball`'s `.vp-menu-body`.

Test changes: `nso_wire_wheel_test` section 1/1b/2/10b drive Scale and the sliders (a new check
that the card has no number box and no H / R); section 2 builds its 46.58 mm ball through the
strict API (`NSO_wheelRun('ball', { height: 60 })`), as does the pin in `nso_wire_stock_test`;
`nso_shell_v3_test`'s and the QA tour's control lists use the slider ids; `nso_wheel_test` gains
three Scale checks (197).
