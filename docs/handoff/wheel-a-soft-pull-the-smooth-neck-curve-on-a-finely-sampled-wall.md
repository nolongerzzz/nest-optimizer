## Wheel: a soft pull - Tube Edge's Smooth curve on a finely sampled wall
`app-wheel.js` (`NSO_wheelFalloff`, `NSO_wheelRefineBand`, Pull's `kernel` / `refine` options,
the smooth ramp in `NSO_wheelStretchAbove`), the Soft slider (5-100%, default 40%). Write-up:
`docs/POTTERY-WHEEL.md` "A soft pull".

The ask: "can we make the angles softer on the pull" - then, after two screenshots, "right now we are
more funnel than smooth, in reference to the tube edge card". Pulls were two straight cones with a
sharp ridge; the target is Tube Edge's Smooth neck.

What it was (measured on the owner's exact settings: Ø54, wall 3.6, thick 10.9, deep 0.8, pull +24
at 40%, soft 60%): 86 degrees between neighbouring segments of the outside profile. Not the curve:
the wall had too few samples (35 on the whole outside), so a big pull drew straight facets. Fixed by
refining the wall inside the pull's band by HEIGHT with a step that follows the falloff's curvature,
plus the SAME cosine Tube Edge's Smooth neck uses (matched to 5.6 microns on a plain tube), plus a
smooth ramp in Open's stretch (it left a 35 degree crease at the foot of every opened piece before any
pull).

Things a later ticket should read before touching this:
- **The strict API is unchanged on purpose.** `NSO_wheelPull` defaults to the biweight and no refinement
  (the older tests pin it); the recipe passes `kernel: 'cosine', refine: true` through
  `NSO_wheelPullClamped`, which forwards them to every bisection call.
- **Refine by height, not length.** A pull moves a sample by a function of its z, so a near-flat segment
  gains nothing from being cut by arc length. The first cut used arc length and a 0.5 mm floor and left
  a 48 degree turn at the widest point of a pressed edge (samples 0.4 mm apart, shorter than the step).
- **`moved` is the largest displacement applied**, not an index-wise comparison against the old profile
  (refinement changes the sample count).
- **The Open stretch has a ramp now (`band`, default 60% of the height above the floor).** `band: 0` is
  the old hard split, kept as an option for the tests that document the old crease. The "no more than
  50x" guard became 1000x: x49 was the hard split's own factor on a thin opening and the ramp needs ~1.5x
  that; the wall/height gates downstream refuse what cannot be built.
- **Opened pieces are a little taller** for the same clay (the ramp stretches the lower wall less).
- Cost: a pull rebuild is ~10 ms; a whole recipe build is still ~60-130 ms.
- The strict-mesh display is flat-shaded (a triangle soup), so a smooth curve still shows faint bands.

`npm run wheel` (255 checks, section 7h) and `npm run wire:wheel` (the Soft slider reaches 100%; a broad
+12 mm pull turns 6 degrees).
