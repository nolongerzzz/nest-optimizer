## Wheel: Lip - a flared rim on a pressed plate
`app-wheel.js` ("7e2. LIP": `NSO_wheelLip`, `NSO_wheelLipShape`, `NSO_wheelLipProfile`,
`NSO_wheelLipRise`; the recipe's `lip` stage; `NSO_wheelTopZ` / `NSO_wheelHeightOf`),
`app-wheel-live.js` (three sliders), the Wheel card. Write-up: `docs/POTTERY-WHEEL.md` "Lip".

What it is: the plate-lip the owner's reference shows - a pressed plate whose perimeter rises
with a flared transition. Sliders **Lip** (rise), **Lip at** (start, % of the radius), **Flare**
(ease length, % of the lifted part). A recipe stage after Open. Constant-thickness slab, midline
turned up on a sin^2 ease, clay conserved by solving the bent length (the diameter falls out a
few mm under the flat plate's), angle solved for the height (capped at 70 degrees, said so).

Things a later ticket should read before touching this:
- **A lipped plate is an opened piece** (outer = underside, inner = top face) and both profiles
  are z-monotone, so nothing else needed a new representation. The loop-profile refactor
  ("Direction" step 4) is still wanted for Pull quality on flat faces, not for Lip.
- **The rise is measured at the rim's highest point above the plate's top face**, which is the end
  of the INNER arc, not the end of the outer profile. `NSO_wheelHeightOf` is the higher of the
  two profiles; the status line, the build-volume check and the canonical manifest all use it.
  Anything new that reports a height should too (`NSO_wheelSpan(piece.outer)` is the OUTER
  profile's span and is short by ~2 mm on a lipped plate).
- **Rise integration uses the profile's own 96 midpoint steps**, so the rise solved for is the rise
  drawn. Iteration counts are as low as the eye allows (a build is ~60 ms); do not "tighten" them.
- **A longer Flare is a steeper finish** for the same height (more of the length is spent in the
  gentle ramp). A Flare too tight for the thickness is lengthened so the top face does not cusp
  (radius of curvature >= h/2).
- **Lip stands down for Deep, an unpressed ball, a thick bulge** - with a note and a tooltip, never
  a disabled slider - and the recipe REMEMBERS the lip, so drag Deep back to 0 and it returns.
- The rim is closed by a chord of 0.6 h (rounded outer corner, flat-ish inner), not a full round
  bead: a full bead makes the two profiles touch at the tip and the wall gate reads zero there.
- `piece.press = { h, e, c }` is set by Flatten and not carried through other moves; Lip runs
  straight after the press in the recipe, so it sees it.

`npm run wheel` (237 checks, was 205; section 7g), `npm run wheel:canonical` (111: the lipped plate
is in its manifest - a closed manifold solid) and `npm run wire:wheel` (section 10d: the sliders
drive it live, thickness and clay hold, it stands down for Deep and an unpressed ball and comes
back, the 70-degree cap, undo and the white edge).
