# Support tree shape — what a real Bambu tree measures, before building more

`npm run tree:shape` — `tools/nso_support_tree_shape_check.js`, 12 checks,
~11 s, no browser. Every number below is re-derived from the file on each run.

## The reference, and why it is the only one

`fixtures/3mf/tabletop.gcode.3mf` — a real Bambu Studio slice, 196,918 Support
moves over 64 layers. Its settings block says what Bambu was *told* to build:

| setting | value |
|---|---|
| `support_style` | **`tree_organic`** |
| `tree_support_branch_diameter` | 2 mm |
| `tree_support_branch_diameter_angle` | 5° |
| `tree_support_wall_count` | −1 (auto) |
| `nozzle_diameter` / `support_line_width` | 0.6 mm / 0.62 mm |
| `layer_height` | 0.3 mm |

`supportwithinsupport.gcode.3mf` was the only other candidate. It has **no
`Support` feature at all**, only 291 Support-interface moves, so it holds no
tree.

## Method

`tree:reference` clusters moves into islands (anything within 1.5 line widths).
That is right for counting trunks and too coarse for forks: **351 of the 407
island "forks" were already two separate extrusion paths on the layer below**,
just closer than the 0.91 mm clustering radius. So this check works at the
level the slicer prints, the **extrusion path**: a run of moves consecutive in
the file and continuous end to start (to 0.01 mm; Bambu's arc endpoints land
up to 1.4 × 10⁻³ mm off after rounding, so a 10⁻³ tolerance splits real loops).
Each path is rasterised at 0.04 mm with every move at its own width and
flood-filled from outside. That gives its printed outline, bore, wall
thickness, convexity, roundness and second-moment ellipse. Paths are linked
layer to layer by outline overlap; every path above layer 2 has a parent.

## Finding 1: taper

**One linear law covers trunk and branch alike.** Over 1,824 lone, round,
convex slices above z 2.4:

> **eqD = 1.97 + 0.172 × (height below the interface)**, r² 0.988, rms 0.085 mm

That is the file's own settings: a 2 mm branch diameter at the tips, growing
2·tan 5° = 0.175 mm per mm going down. **There is no separate trunk
profile.** A trunk is the same law at a larger depth: single trunks measure
4.77 mm at z 2.4, shrinking by exactly that slope for as long as they stay
single.

| height below interface (mm) | n | eqD p10 / med / p90 (mm) | law |
|---|---|---|---|
| 0–2 | 168 | 2.06 / 2.14 / 2.22 | 2.14 |
| 4–6 | 262 | 2.68 / 2.84 / 2.96 | 2.83 |
| 8–10 | 256 | 3.41 / 3.58 / 3.74 | 3.52 |
| 12–14 | 144 | 4.02 / 4.20 / 4.43 | 4.21 |
| 16–18 | 90 | 4.61 / 4.71 / 4.77 | 4.90 |

**Profile: linear.** No curve is needed to fit it (rms 0.085 mm).

**The base is a separate feature, not the taper.** Every one of the 36 trunks
starts at 6.57–6.59 mm at z 0.6, **+1.35 mm** over the law. The excess shrinks
to +1.07, +0.64 and +0.19 mm at z 0.9, 1.2 and 1.5, and is gone by z 1.8.
Under that sits a solid first-layer pad of about 10 mm (57 paths, no bore).

## Finding 2: walls

Every slice **2.2 mm and wider is a tube with one support line of wall**
(0.62 mm median against a 0.61 mm line) around a bore that grows with the
diameter: bore/eqD 0.31 at 2.2–2.6 mm, 0.70 at 4.6–5.0 mm. Only the ~2 mm tips
close up (wall 1.03 mm, bore in 46 %). This agrees with the physical
dissection: trunks and even small branches are hollow.

## Finding 3: a branch is a slanted round tube, sliced

A leaning branch's slice is an **ellipse stretched by 1/cos(lean) along its own
direction of travel**. That is what a round tube cut by a horizontal plane
gives:

| lean | n | axis ratio | 1/cos(lean) | long axis vs travel |
|---|---|---|---|---|
| 20–30° | 703 | 1.110 | 1.133 | 3.0° |
| 30–45° | 35 | 1.167 | 1.177 | 1.5° |

So the branch is a swept 3D solid, not a stack of per-layer circles.
(Below 20° lean the ellipse test is swamped. Slices elongated *across* their
travel there are two branches still in one contour: 96 % of them split into
two contours within 3 mm.)

## Finding 4: forks

- **Contours on one layer never overlap**: 0 of 6,351 neighbouring pairs.
  Where branches touch, the layer prints **one** contour.
- Going up, one contour splits into two **456** times; two contours join into
  one **once**.
- Before a split, the single contour is **two-lobed** for a median of 7 layers
  (2.1 mm), p90 11. Its lobes are **circular arcs**: two fitted circles match
  the outline to 0.072 mm rms, lobe radius 1.28 mm.
- The waist is **filled past a union of circles** once the lobes are apart:
  +0.07 mm at 1–1.5 mm centre spacing, **+0.50 mm** at 1.5–2 mm and
  **+0.73 mm** at 2–3 mm, over the two circles' intersection. That is the size
  Finding 3's ellipses predict (r 1.27 mm stretched by ~1.12, 2.5 mm apart →
  about +0.75 mm). This is consistent with, not proven by, a direct ellipse fit
  at the fork.
- **A merged contour is one wall around one merged bore**: 3,032 of 3,279
  two-lobed contours have a single bore.

**What the fork is:** the toolpath is **the union of swept round tubes,
sliced**. One wall runs around the union's outline and one bore runs through
the union's interior. There is **no evidence of one cross-section deforming
continuously** into two, and **no separate transition piece**. The only
junction shape is what two overlapping slanted tubes give when sliced. Bambu's
fork is a local union.

## Scoping the next geometry change, against the measurements

**Status:** 1 and 2 are built. See `docs/SUPPORT-TREE.md` §6b and
`npm run tree:round`. 3 is next.

What this repo builds today: a **square** 1.2 mm strut and branches of **one
constant section**, the trunk split **once** at a collar with the branches
rooted inside it, unioned with `NSO_unionSoups`. Hollowing is per part with a
keep region, so the junction is a **solid knot**.

1. **Round, tapered sections: the change the evidence most supports.**
   Diameter as a function of **distance below the tip**, `d = d_tip +
   2·tan(θ)·depth`, applied to trunk and branch by one rule. It replaces the
   square strut and the separate trunk idea together. Measured on the real
   reference: `d_tip` 2 mm, θ 5°, linear, r² 0.988. Mechanism: `NSO_PathSweep`
   sweeps one constant profile today (it already has an n-gon helper). A taper
   needs per-station scaling, and a linear frustum keeps its side walls planar
   (each rail pair meets at the cone's apex), so the sweep's exactness argument
   survives. Side effect that matters for the Bambu test: a 2 mm tip hollowed
   at a 0.42 mm wall leaves a 1.16 mm bore, against 0.36 mm in today's 1.2 mm
   strut.
2. **The junction: no reconstruction, but let the bores merge.** The fork is
   already built the way Bambu builds it, a union of swept tubes. The
   measured difference is inside: a real merged contour has **one bore**,
   where ours has a solid knot. With round tubes this becomes exact and cheap:
   `union(outer tubes) − union(inner tubes)`, each inner tube on the same path
   at radius `r − wall`. Every bore point is a wall inside its own tube, so no
   wall to the outside can drop below the floor, and the bores merge the way
   the real slices show. It would replace the sampled erosion and its keep
   region for trees; `nso_hollow.js` stays for arbitrary pieces.
3. **The base foot: real, small, last.** A +1.35 mm flare decaying over
   ~1.2 mm, on a ~10 mm solid first-layer pad. It is an adhesion feature, not
   a taper. Build it as its own short frustum under each trunk, once 1 is in.

**Not settled by this file, and not assumed:** the **curvature** of branch
paths (the reference branches lean continuously; ours are straight segments)
and **repeated splitting** (the reference splits hundreds of times; ours
once). Both are visible in the data but were not the question here. The
reference is one slice on one printer profile (0.6 mm nozzle), so `d_tip` and
θ are *its* settings, measured true to them, not universal constants.
