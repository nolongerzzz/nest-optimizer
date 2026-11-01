## Wrap - one feature (ball, spike, pyramid, bump, dent, line) laid over a face, with a skin for each design on the two plates (2026-11-01)

Write-up: `docs/SURFTEX.md`. New: `nso_surftex.js` (the engine: faces, fits, charts, lattices, motifs, the patch), `nso_surftex_presets.js` (the 12 design
skins and 6 single features), `app-surftex.js` (the card: **Surface & edges -> Wrap**, a sub-menu in flow, like Gen+'s Wheel), `tools/nso_surftex_fixtures.js`,
`tools/nso_surftex_test.js` (`surftex:test`, 101 gates, ~2 min), `tools/nso_surftex_drive_check.js` (`surftex:drive`), `fixtures/surftex/` (each design skin on a
bare primitive of its own kind, STL, and a contact sheet). `nso_cdt.js` gains an optional third argument to `triangulate(points, segments, nHard)`: segments past
`nHard` are forced edges that do **not** turn inside into outside (default: all outline, as before; `weave:test` still passes). `app-core.js` one undo label
(`wrapReplace`); `index.html` the card and three script tags (`npm run stamp` sets their `?v=`); `styles.css` a few rules.

The two plates the skins come from (`nest_Bambu_A1__P1S__X1C_315pcs.3mf`, `spikefoot.3mf`) were measured, not guessed: the rollers are a 95 mm tube (Ø40 over a Ø15 bore)
with 70 / 140 / 77 pyramids (arc pitch 9.0 / 9.0 / 11.7 mm, rows 17 / 8.6 / 12 mm, 9.0 / 5.35 / 6.1 mm tall); "1.0" is R 22.5 with 268 spikes 4.0 mm apart; the ball dome has
32 balls; the spikefoot is an 8.0 mm grid of 4.95 mm square pyramids 3.43 mm tall (the 300 loose "lifted" pieces on the nest plate are those pyramids, 4.95 x 3.43 / 4.33).
On a bare roller Soft Spikes and the Ribbed Roller reproduce the designs' feature counts and reach exactly (gates `6a`).

Things worth knowing:
- *Dead end, so nobody walks it again.* Weave's remesher (`_isoRemesh`, via `plan(..., {fit: 'follow'})`) as the base patch, then displace its corners: it grades from the
  rim, and a clean primitive's rim edges (a 64-facet cylinder: 1.96 mm) are far from the pitch - 223,000 triangles at a pitch of 0.8 mm, angles down to 0.6 degrees, 10 s - and
  an apex falls between corners. Wrap places the apex, the footprint corners and the rings itself and triangulates them with the CDT.
- *Forced edges need their own kind.* `nso_cdt.js` decides inside by parity of the segments crossed, so a footprint outline drawn inside the face turned its inside OUT.
  Hence `nHard`. Without forced edges, the shared edge of two touching pyramids is a cocircular tie and Delaunay is free to put the apexes' edge there instead.
- *A cylinder is five periods, not a seam.* The rim chains are laid over five periods, the tiles and the fill over three, and a triangle is kept in the one copy where its
  lowest-numbered corner stands in the middle period. A centroid test (the obvious one) put a triangle centred exactly on the boundary in both copies or neither (float noise): open edges at the seam.
  Both rim chains must start within half a period of the same x, or the closing edges slant across the features (a cylinder lying on its side hit it).
- *Welding.* Corner points within a micron are one point (touching footprints on a plane / cylinder). On a sphere or a contoured face the shared edge of two tiles is a few
  hundredths of a mm apart (each tile has its own tangent frame) and no weld radius is safe (it merges the profile points 0.13 mm apart in a round line), so touching features are held 2% apart.
- *Sphere.* Stereographic chart (exact spherical Delaunay), but the FILL is laid on latitude rings in 3D, not on the chart: a lattice on the chart put 80,000 triangles on the far side.
  The fill's "is this inside a footprint" test is in 3D for the same reason (a stretched chart let fill points land on a spike's face and dent it).
- *Phases.* The lattice is centred in the face; trying the four half-pitch phases and keeping the one with the most whole features is what makes the Ribbed Roller 140 and not 126.
- The shell tests that list the column are untouched: Wrap is a sub-menu of Surface & edges, because a 15th column button leaves no gap above Slice at 1280 x 800 (`shell:v3`
  gate "bottom stack" failed). `CLEAR PLATE` in `shell:v3` fails on the tree without this change too.

Not done, by choice: concentric rings and swirls (the pads' `66.stl_4`, `_6`, `_12`) are not one feature repeated; a ball past a hemisphere (an undercut); clipping a feature at the face's edge
(whole features only, `Margin` clear); a custom feature from a picked mesh (the five parametric features cover the ask - `motifModel` is the place to add a heightfield sampled from a mesh).
