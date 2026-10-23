## Bend - a pipe or plate bender (2026-10-13)
`nso_bend.js` (headless) and `app-bend.js` (the panel), loaded after
`nso_section.js` at `?v=bend1`. UI is a **Bend** button in the Finish menu's
Shape group, in the row under Extend, opening a small panel (Where, Angle,
Radius, Toward / Roll, Bend, Cancel) with a live ghost and a marker on the
piece. Full write-up: `docs/BEND.md`.

Folds a piece inside one clean constant-section band (Extend's band finder)
and holds the section exact: the zone's walls are cut at its two ends, the
section is swept round the arc with radial stations
(`NSO_PathSweep.sweepArc`, new, multi-loop and non-convex), and everything
past the zone turns rigidly. Before a later ticket touches it:
- **The axis is the longest with a clean band**, not Extend's least-oblique
  one: a bent plate's least-oblique axis is always its width, which would make
  a second bend impossible.
- **Rigid to 1e-9 is a float64 claim.** Stored float32, the far part is the
  nearest float32 to its exact rigid image (gated), not rigid to 1e-9 mm.
- **The step count has a volume rule** as well as the 0.02 mm sag rule, so
  the arc's volume is `A x centroid travel` to 0.05% on its own.
- **Self-intersection** is impossible for a plain prism up to 180°; a tab or
  flange can fold into the near arm, and that is checked and refused.

`npm run bend:test` (headless) and `npm run bend:drive` (real app), both in
`npm test`.
