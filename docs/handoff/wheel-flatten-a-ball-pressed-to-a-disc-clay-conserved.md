## Wheel: Flatten - a ball pressed to a disc, the clay conserved
`app-wheel.js` (`NSO_wheelFlatten`, `NSO_wheelFlatSolve`, `NSO_wheelDiscProfile`),
a **Flatten** button and thickness box in Gen+ > Wheel, `index.html` re-stamped.
Write-up and the agreed direction: `docs/POTTERY-WHEEL.md` "Flatten" and
"Direction".

What it is: the first step toward plates, bowls, vases and pitchers thrown from
a ball. Press the ball down and the top comes down, the clay spreads, and the
diameter grows by exactly what the height gives up, until the piece is a flat
disc with a rounded edge. A 46.6 mm ball is 49.9 mm across at 40 mm thick, 63.7
at 20, 150.5 at the 3 mm wall.

Four things a later ticket should read before touching this:
- **It is the first move held to the piece's own volume, not the budget's
  ceiling.** The form is solved (bisection on `NSO_wheelVolume`, the polygon the
  revolve tessellates, low side kept) so its volume equals the live volume to
  1e-16. Open and Pull are meant to follow; today they do not - Open throws the
  top half of the ball away and Pull displaces radially against a ceiling, and a
  Pull on a pressed disc is refused as out of material. That is pinned in the
  self-test as a known gap, and flips when Pull conserves.
- **The result is a function of the clay and the height, not of the history.**
  Pressing a thin disc back up lands on the same form as pressing the ball
  there. That is what lets a drag go down and up along one curve later.
- **A flat disc is already the shape `r(z)` handles badly.** Its faces are
  horizontal, so runs of samples share one `z` (Trim's flat base already did
  this). Flatten is safe on it; Pull, Open and Lip on top of it want the profile
  as a closed `(r, z)` loop - the gate, the volume and the revolve are already
  loop-general. "Direction" item 4.
- **`NSO_wheelSession` still belongs to nobody.** Undo steps the mesh but not the
  session, and a move bakes onto whichever piece is selected. Flatten dodges it
  by being a function of the clay; the next moves will not. "Direction" item 5.

Test change worth knowing: the canonical checker's "measured solid is inside the
material ceiling" moved from an absolute 1e-6 mm^3 to the 1e-6 relative float32
storage bound its neighbour already asserts, because a clay-conserving piece sits
exactly on the ceiling.

`npm run wheel` (120 checks, was 96), `npm run wheel:canonical` (95, was 80, the
pressed disc included) and `npm run wire:wheel` (a new section 10b: real clicks,
the measured mesh, a refusal, Undo).
