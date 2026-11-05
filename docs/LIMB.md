# Limb - grab a branch anywhere along it, then stretch it or bend it

`nso_limb.js` (the tree, the limb, the move and its guards, headless), `app-limb.js`
(the pointer session) and `nso_densify.js` (the shared subdivision), under
**Shape -> Limb**, beside Pull.

```
node tools/nso_limb_test.js          headless, on fixtures/tree_sample.stl (49 checks)
node tools/nso_limb_drive_check.js   the real app at 1280x800: hover, drag, Shift, Alt, Escape, click, Apply, Reach
LIMB_SHOTS=dir node tools/nso_limb_drive_check.js     screenshots elsewhere (default tools/limb-out/, git-ignored)
```

Both are in `npm test` (`limb:test` in `testSteps`, `limb:drive` in `driveSteps`). The
drive check wants Chromium where Playwright's build expects it; elsewhere,
`PW_CHROMIUM=/path/to/chrome`.

## Why it is not Extend, and not Pull

The ask: *extend and bend the branches of a tree, to shape and reshape it.*

* **Extend** holds the cross-section bit for bit, so it needs ONE straight axis and
  that axis must be X, Y or Z. A tree has none: the sample's trunk leans 3.25 degrees,
  and its branches leave at every angle. Extend on the whole piece says
  *"dominant axis is off-cardinal by 3.25 deg"*, and there is no way to hand it one
  branch.
* **Pull** has no axis rule, but its falloff is a ball of radius <= 50 mm in *space*.
  Grab one tip and the twig beside it comes too, and what moves, moves with a bell:
  nothing is carried whole.

A branch is found by its topology, so that is what Limb uses.

## The gesture

| | |
|---|---|
| **Arm** | select a piece, press **Limb**. Hover a branch: an orange **ring-and-dot** marks the loop a grab would take (the *handle*), a white dot the **hinge** where that limb leaves its fork, and a bar joins them: the stretch of the limb that will flex. |
| **Drag** | press on a branch and drag. After 4 px the flex zone is densified (1 mm) and the handle follows the cursor **in the view plane** - the limb leans and lengthens to land the handle on the cursor. Everything out beyond the handle rides along, rigid. Orbit the camera to bend in another plane. |
| **Shift** | **Extend only**: only the part of the drag along the limb counts. |
| **Alt** | **Bend only**: the limb swings toward the cursor, its length held. |
| *Mode buttons* | **Stretch + bend / Extend / Bend** in the panel are the same three, held. |
| **Release** | is Set. One Undo step. There is no Set button. |
| **Escape** | mid-drag puts the piece back exactly. |
| **Click** | picks a limb without moving it. **Extend (mm)**, **Bend (deg)** and **Lean** in the panel then apply to it with **Apply** - for a number rather than a drag. |
| **Reach** | 0 (the default): the flex zone runs down to the fork. A number: only that many mm below the handle flex, so the bend is tighter and nearer the grab. More than the fork allows is cut to the fork, and the status line says so. |

**"Grab a lower section to extend the tip."** Press lower on the branch. Everything
beyond the press - the tip, its twigs, its sub-branches - is carried whole, and the
stretch of branch between the press and the fork below it is what lengthens. Grab the
last prong and one prong grows; grab below its sub-forks and the whole sub-branch
slides out. There is no length limit on a lengthening.

The preview is not a commit: while dragging the placed mesh shows a throwaway geometry
and `m.rawTris` is untouched. A refused, cancelled or lost move ends by putting the
original geometry back.

## How the limb is found

The **root** is the part of the piece that sits lowest (the lowest 3% of its height:
the trunk's foot). `d(v)` is the distance over the surface from the root to every
vertex (Dijkstra on the mesh's edges), so a branch is a stretch of surface where `d`
runs from its fork up to its tip, and the level sets of `d` are the loops that go
round it. Sweeping the vertices from the highest `d` down with a union-find gives:

* **Carried** - the vertices still connected to the press through vertices at least as
  far from the root as the press: the tip end, and everything that grows out of it.
* **Fork** - going down, the first vertex where the press's branch joins another
  branch that stands more than 1.5 mm above that vertex. A bump on a tip is not a
  branch (the sample's tips have two local maxima a fraction of a millimetre apart on
  each prong; both resolve to the same limb - tested).
* **Limb** - everything above the fork. **Hinge `Q`** - the centre of the loop where
  the limb meets the fork; **handle `A`** - the centre of the press's own loop. `Q -> A`
  is the limb's bone. The vertices between the two loops are the **flex zone**. It is
  one internode (the fork is the first junction), so nothing grows out of it.

Measured on `fixtures/tree_sample.stl` (a 71 mm tree, 3,796 triangles, one closed
surface, V - E + F = 2): all **31** local ends resolve to a limb with a fork below it.
23 are prongs, 11.3-14.5 mm from fork to tip with a ring radius of about 0.7 mm; 8 are
short stubs, 1.6-4.4 mm from their fork, with ring radii from 0.9 to 11 mm (the knobs
at the tree's joints). Pressing mid-prong finds the same fork as pressing the tip
(tested); pressing low on the trunk carries 1,868 of the 1,900 vertices.

## The move

The handle `A` is taken to a new place `A'`. The bone `Q -> A` (length `L`) becomes a
bone of length `L + e` that leans by an angle `theta` toward the cursor. The flex zone
is bent the way the **Bend** tool bends a pipe, with one change: the turn and the
growth are not spread evenly but ramp with `g(s) = smoothstep(s / L)`, so neither
jumps at the fork or at the handle.

```
centre line   c(s) = integral 0..s of  sigma'(s') ( cos(phi) u0 + sin(phi) b ) ds'
              phi(s) = theta g(s)      sigma(s) = s + e g(s)
a vertex at (s, y, z)  ->  Q + c(s) + y ( cos(phi) b - sin(phi) u0 ) + z n
```

`s` runs along the bone, `y` toward the lean `b`, `z` across (`n = u0 x b`). Every ring
of the zone is carried whole, so the limb's **girth is the girth it had**; the centre
line is exactly `L + e` long. The zone leaves the fork along `u0` with no curvature and
the tip end leaves it along `u1`, turned by `theta`, with none. The carried part takes
the rigid motion that carries the zone's end frame, so **its shape is untouched**
(tested: 97 of the 104 carried vertices of a mid-prong grab keep every distance to
7e-15 mm; the other 7 sit on the tilted cut and follow the zone's law, which is what
keeps the seam from folding, and are within 0.012 mm of rigid). A pure Extend is
`theta = 0`: each ring slides `e g(s)` along the bone and none changes shape (tested:
worst sideways move of any vertex 4.6e-15 mm).

**Following the cursor.** A bent pipe's end is not where its tangent points, so a drag
asks for the handle to *land* on a point and Limb solves for the `(theta, e)` whose
`c(L)` is that point (Newton, a handful of steps). On the sample, six cursor targets
from 6 mm sideways to 20 mm straight out land to better than 2e-10 mm. *Bend only*
fixes `e = 0` and solves `theta` alone; *Extend only* fixes `theta = 0`.

**Everything else is copied through untouched.** Not one vertex outside the limb moves
by a bit (tested: 2,006 vertices held). Nothing is scaled, welded or deleted. The flex
zone is densified to 1 mm first (`nso_densify.js`: 3,796 -> 4,694 triangles for a
prong), so the bend has vertices to bend with; the rest of the piece keeps its triangles.

## Limits, and the guards

| | |
|---|---|
| **Bend cap** | the zone folds over itself where its radius of curvature is no bigger than its own half-width `w`; the curve is tightest mid-zone, where it turns at `1.5 theta / L` and the centre line grows at `1 + 1.5 e / L`. So `theta <= (L + 1.5 e) / (1.5 x 1.2 x w)`, and never more than **110 degrees**. A drag past it is cut and the status line says *"bend capped at N deg by this limb's width"*. On the sample, a thin 15 mm prong takes 110 degrees; a 2.1 mm stub 10 mm across is held to 13.7 degrees when 100 were asked. |
| **Shortening** | stops at 40% of the zone. |
| **Fold** | a triangle gone to zero area, or turned inside out, refuses the move. A bend turns every surface normal by up to `theta`, so a clean 110 degree bend reverses them all; the check compares each triangle's new normal with its old one *turned by the bend its vertices went through*, not with the raw old one. *"the bend is too sharp for this limb (grab lower, or bend less)"*. |
| **Self-intersection** | the canonical count (`NSO_Repair`), before and after on the same triangulation, over the triangles in the box the moved vertices travel through; it may not rise. *"the moved limb would pass through the tree (43 self-intersecting pairs where it had 0)"* - the sample's twig 814 bent 110 degrees into the trunk. 30 of 31 ends take 45 degrees toward +X; the other, the 11 mm stub 282, would meet the trunk (4 pairs). |
| **Paint** | **PAINT SCOPE: SUB-REGION** (`docs/HANDOFF.md`): the limb's moved vertices are tested, where they were and where they went, against `nsoMaskPlaneList(m)` with the Brush's own `NSO_brushPaintCheck`; paint elsewhere on the piece does not stop it. Operand none; non-solid not read. |
| **Support piece** | refused at the press: supports are generated, not sculpted. |

A refused move says why in words and hands back the piece unchanged
(`finish().tris` is the soup it was given).

## What it does not do

* **The root is the lowest part of the piece.** A tree lying on its side must be stood
  up first (Tip -> Stand), or "beyond the grab" points the wrong way.
* **One connected surface.** A piece in several shells (a hinge, a box with a cavity) is
  refused by name: distance over the surface has nowhere to go between them.
* **Not a tool for flat-faceted prisms.** A cylinder or a box has no fork, so the "limb"
  is the whole piece swinging from its foot, which is said in the status line and is
  rarely what is wanted. A cylinder's long planar facets, densified and then moved even
  by an exact slide, also trip the canonical checker's float32 coplanarity (a 3 mm
  Extend of `cylinder_r10h30_s64.stl` reads 106 piercing pairs, and `mesh_validate.py`
  agrees), so Limb refuses those moves in the checker's words instead of handing over
  a mesh that checker fails. The sample did not trip it: in 93 trials (each of the 31
  ends turned 60 and 110 degrees toward the trunk, and 45 degrees toward +X) the checker
  refused two, a twig turned into the trunk and the thick stub 282, each a limb turned
  into its neighbour.
* **No twist, no second handle, no pins.** One handle per move; a second limb is a second
  move. Pull's pins have no equivalent here: the fork is the anchor.
* **The drag is in the view plane.** To bend a limb out of that plane, orbit and drag
  again, or use the Bend number with a Lean.
* **A large piece pays once.** The first hover on a piece welds it and measures the
  distance from the root (81 ms for the sample, about 0.4 s for 33,000 triangles); after
  that a hover costs under a millisecond on the sample.

## Files

`nso_limb.js`, `app-limb.js`, `fixtures/tree_sample.stl` (the sample, from the 3MF it
came in), `tools/nso_limb_test.js`, `tools/nso_limb_drive_check.js`; `index.html` (the
button, the panel, two script tags), `styles.css`, `app-core.js` (the undo label and the
pointer ask beside Pull's); and the mutual disarm, both ways, in `app-brush.js`,
`app-carve.js`, `app-center-lock.js`, `app-input-mode.js`, `app-lift-plate.js`,
`app-mask.js`, `app-measure.js` and `app-pull.js`.
