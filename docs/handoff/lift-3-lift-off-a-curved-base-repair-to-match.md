## Lift 3 - lift off a curved base, repair to match (2026-10-13)
Branch `claude/lift-curved`, off `claude-wip`. Full write-up: **`docs/LIFT.md` §6**.
- **What changed:** Lift 2 refused a detail whose base bends more than 0.15 mm;
  `NSO_LiftAuto.analyse(..., { curved: true })` now cuts it along the surface
  and makes the plate good with the surrounding surface carried across,
  welded to the real neighbour triangles at the rim (same corners, the slope
  carried by a cotangent-Laplacian solve on the fill + the rim's real star,
  relaxing to the base over 1.5 mm). Detection unchanged.
- **The base** under a curved island is quadratics fitted (locally weighted,
  sigma 3 mm) to the surround the rolling ball touches - not the ball's own
  curve under the detail, which dips 0.25 - 0.35 mm under a convex surface
  (measured; in the doc). Ball fallback, said in words, where no quadratic fits.
- **`nso_lift_curved.js`** (new): the fill. `nso_lift_auto.js`: the option,
  the slant refusal (35°), the notes. Flat faces: bit for bit Lift 2.
- **UI:** G-scope's Lift reads with `{ curved: true }` in Pick (curved face) and
  Strip; read-out and Lift / Remove messages say "cut along the surface" /
  "the surface round it carried across", plus the honest-ceiling notes.
- **Paint scope:** unchanged (whole-piece, roster row above).
- **Checks:** `lift:curved-test` (483), `lift:curved-drive` (23) in `npm test`.
  `lift:auto-drive`: the five gates that said the dish's squiggle is refused
  now say it lifts (the ticket's change); everything else unchanged.
- **Tags:** `nso_lift_auto.js` and `app-gscope-lift.js` lift2 -> lift3,
  `nso_lift_curved.js` new at lift3.
- **Later ticket, flagged:** lift as a reusable skin (keep the lifted detail /
  texture to stamp elsewhere). Not built.
