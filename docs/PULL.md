# Pull - grab a spot on a piece and drag it

`nso_densify.js` (the shared subdivision), `nso_pull.js` (the field and its
guards, headless) and `app-pull.js` (the pointer session), under **Shape -> Pull**.

```
node tools/nso_pull_test.js          headless: densify, field, pins, tube, box, guards (72 checks)
node tools/nso_pull_drive_check.js   the real app at 1280x800: gesture, pins, Shift, Escape, refusals
PULL_SHOTS=dir node tools/nso_pull_drive_check.js     screenshots elsewhere (default tools/pull-out/)
```

Both are in `npm test` (`pull:test`, `pull:drive`).

(A mid-drag screenshot is in the PR description; the drive check writes its own to `tools/pull-out/`, which is git-ignored.)

## The gesture

| | |
|---|---|
| **Arm** | select a piece, press **Pull**. The panel's slider *is* the Brush's size slider (the two are mirrored): the falloff radius, 1-50 mm, 12 by default. |
| **Click** | a plain click on the piece drops a **pin**: a spot that holds still. It is drawn as a small red anchor with its radius, keeps the radius the slider had when it was placed, and stays until **Clear pins** or until Pull is left. |
| **Drag** | press-and-drag a spot to **grab** it. After 4 px the triangles under the grab are densified (below) and the real mesh follows the cursor, live, in the **view plane** - the plane through the grab, square to the camera. **Shift** moves it **along the surface normal** at the grab, in or out. |
| **This side only** | a checkbox in the panel, off by default (below). |
| **Release** | is Set. One Undo step. There is no Set button. |
| **Escape** | mid-drag puts the piece back. **Cancel** does the same and leaves the tool. |

The preview is not a commit: while dragging the placed mesh shows a throwaway
geometry and `m.rawTris` is untouched; a refused, cancelled or lost pull ends by
putting the original geometry back.

## The field

A pull has a grab (a point, a radius, a displacement **D**) and any number of pins
(a point and a radius each). Every vertex within the grab's radius moves by

```
D * phi(v)         phi = g(v) * s(v)
g  = bell(d_grab / r_grab)             bell(t) = u*u*(3 - 2u), u = 1 - t     1 at the centre, 0 at the radius, flat at both ends
s  = product over pins of ( 1 - bell(d_pin / r_pin) * q ),   q = w_pin / (w_pin + w_grab),   w = 1 / (d^4 + 0.05^4)
```

A pin holds by *its own* bell, weighted by how much nearer it is than the grab. So
**the nearest handle wins where the radii overlap - and wins smoothly**: at a pin's
vertex `s = 0` (it does not move); at the grab's vertex `s = 1` (it follows the
cursor exactly, even with a pin's radius over it); in between they blend, with no
step where "nearest" changes hands (a hard winner-takes-all would leave a cliff
there; the test scans for it). `phi` depends only on where the vertices were and
where the handles are, never on D, so it is worked out once and every mouse move
after that is `base + D * phi`.

The grab (always) and a pin (when a vertex is within 0.6 mm) **snap to the nearest
vertex** of the densified mesh, so "the lip moved 6 mm at the grab" and "the pinned
vertex did not move" are statements about a vertex.

### Where the distance is measured - three ways

| | the falloff distance is measured |
|---|---|
| **the section rule** (default) | from the wall's **mid-surface**, not through space. Each vertex is paired with its opposite-skin partner - the first surface met along its inward normal, if it is within 6 mm (deeper is a solid, not a wall), within 2x the *local wall thickness* (the thinnest such hit in the vertex's one-ring: a hit much longer than its neighbours' is a ray that slid out of a corner), and faces back at the vertex - and the vertex takes the displacement of their shared **mid-point**. Both skins get the same vector, so a wall moves as one section. The grab and the pins on a wall are centred on the wall's mid-point too, so both skins at the grab follow it fully. |
| **no partner** | an open edge, a solid, a lip's top face: the vertex's own position, the plain rule. |
| **This side only** | **along the surface** (Dijkstra over the mesh's edges, never across an edge sharper than 60 degrees, and a vertex ON such an edge is reached but not walked on from, so the walk stays on the skin it started on and a bore does not reach the outside by way of the rim). Only that skin moves; the skin behind it stays bit-for-bit. Pins hold along the surface too. No pairing. |

*Where the section rule meets a vertex with no partner* (a wall's rim, an open edge) the two sides would be measured from points up to half a wall apart: a step in
the displacement. That cost 0.46 mm of wall at the rim of a 1.6 mm lip in the first
build of this rule (the 0.8 mm guard refused the pull). So the mid-point offset is
carried outward from the partnered vertices, 12 rings at a fade of 0.85 each: the plain
rule is reached by a slope, not a step. A solid, with no partnered vertex near it,
never gets an offset: it is exactly the plain rule.

Measured, headless, on the Stock tube D20 wall 1.6 (`tools/nso_pull_test.js`): the grab
vertex moves 6.000 mm; every wall vertex moves by `6 x bell(distance from the mid-surface)`
(worst error 0.01 mm, the polygon of the facets); 0 beyond the radius; the tube's far end is
bit-for-bit where it was. With a 30 mm pin on the other lip: the pinned vertex moves 0 mm,
everything within 1 mm of it at most 0.007 mm, while the same spot unpinned would have
moved 2.0 mm; the grab still moves 6.000 mm.

## Densify first - `nso_densify.js`

A coarse mesh has no vertex to take a curve: the top of a 20 mm cube is two triangles.
Before the first drag on a region the triangles within the grab's radius (plus one
spacing) are subdivided so **every edge is at most 0.5 mm**; it is done once, reported
in the status line (`densified to 0.5 mm spacing (768->15222 triangles)`), and a region
that is already fine is left alone (`already 0.5 mm fine here`). It is its own file
because the gun will want the same subdivision, and "how fine is fine" should have one
answer. `NSO_Densify.region(rawTris, {c, r}, {spacing})`.

It splits **edges**, keyed on their vertex pair, so both triangles that share a cut
edge get the same midpoint, including one outside the zone: **no T-junction, ever**,
and nothing is repaired afterwards. Winding is kept, every original vertex keeps its
exact coordinates, the surface is geometrically unchanged (volume and area to float32).

Plain bisection was not enough, and the reason is worth keeping. A revolved wall is
made of needles - a 96-segment tube's facets are 40 mm x 0.65 mm - and bisecting a
needle keeps its angles: 768 triangles became 99,000 for a 12 mm zone, some 0.005 mm
wide (about 13,000 is what the area needs). So a **needle is zipped** instead: its
sides are cut into pieces of at most 0.5 mm and the strip between them laddered; two
needles that are halves of a rectangle are laddered as one quad (the diagonal goes);
the two long sides of a quad - and of the whole ring of quads - share their cuts so the
rungs are square; and the cuts thin out geometrically past the zone's edge so a fine
triangle is never beside a 20 mm one. Result on that tube: 15,222 triangles, median
aspect 2.4, 90th percentile 3.75, `mesh_validate.py --gate` PASS.

That last point is not cosmetic. The first zipper left the canonical checker reporting
**phantom piercing pairs** in 24 of 40 random zones on that tube (60%), 9 of 40 after
quads and grading but before the quad's other half was pulled in from just outside the
sphere: thin, nearly coplanar triangles on a slanted facet, which float32 rounding puts a
millionth of a millimetre off-plane and which Moller's test then calls piercing. They
overlap nowhere (checked in 2D). 0 of 40 now, and `nso_pull_test.js` holds it at 0 over
16 zones. The guard still compares to the densified mesh and not the original (below),
because a phantom is not the pull's doing.

## The guards, at release, on the result

* **Wall** - a wall that would go under **two nozzle widths** (0.8 mm at 0.4) is refused,
  measured as Carve does: `NSO_Thickness.prepare()` on the result, `wallAt()` along each
  station's own inward normal, a station on every moved vertex (about 0.5 mm apart,
  since that is the spacing; over 24,000 vertices it samples every k-th and says so).
  `Pull refused - it would leave 0.737 mm of wall near (8.273, 5.718, 59.519), under the 0.8 mm floor (two 0.4 mm nozzle widths) - piece unchanged`
* **Self-intersection** - the canonical count (`NSO_Repair`), over the triangles the move
  could reach, before and after **on the same triangulation**. A missing checker is a
  refusal, not a skip. `the moved surface would pass through itself (88 self-intersecting pairs where it had 0)`
* **Collapse** - a triangle gone to zero area is a fold.
* **A support piece** (`m.nsoSupport`) is refused at the press.
* **Paint** - Pull is a bake, so it reads the exclude list (docs/HANDOFF.md). It moves the
  vertices inside the grab and nothing else, so it checks only the painted faces those
  vertices lie on. **PAINT SCOPE: SUB-REGION**, operand none (the operand is a gesture).
  Non-solid: not read - Pull neither opens nor closes an edge.

Output stays manifold and `mesh_validate.py --gate` clean: every output in both tests
(a 120,000-triangle tube, a 72,000-triangle pinned one, the box) is run through it as
a real STL.

## What a pull does to a wall

**The wall keeps its thickness across the pulled region, at the radius the ticket's test
uses.** Stock tube D20 wall 1.6, lip pulled 6 mm outward in the view plane:

| falloff radius | thinnest | thickest | `cos(slope)` bound |
|---|---|---|---|
| 12 mm (default) | 1.388 | 1.601 | 1.28 |
| 25 mm | 1.505 | 1.601 | 1.505 |
| 50 mm | **1.574** | **1.601** | 1.575 |

At 50 mm the wall is **1.6 +- 0.05 everywhere** (1.574 .. 1.601; the test asserts it). The
old rule (each vertex by its own distance) measured 1.557 .. 1.868 there: the thick side
was the two skins being carried by different amounts, and that is what the section rule
removes - the wall is never thicker than it was.

**What it does not remove is the tilt, and at a small radius that is not small.** The
two skins now move by the same vector, so the section is carried sideways across a slope,
and a section carried sideways across a slope is thinner measured square to its new
surface, by `cos(slope)` with slope up to `1.5 |D| / r`. At the default 12 mm radius a
6 mm pull still leaves 1.39 mm (1.6 - 0.21), not 1.6 +- 0.05; at 25 mm, 1.51. So "stays
1.6 +- 0.05 at any radius" holds from about 40 mm up and is a cosine below it. Keeping
the full thickness there too needs the section's two half-offsets *turned* with the local
slope (a rotation of the vertex about the mid-point) - one further step on this rule, not
built, because the ticket asked for the pairing and not that. The tests assert the bound
that is true at each radius.

The guard is what keeps either honest. A 0.8 mm wall pulled 2 mm at the default radius
is still refused (it comes out near 0.74).

## This side only

Off by default. On, only the skin under the grab moves and the skin behind it stays: how
the inside of a tube is pushed locally while the outside stays true. The Stock tube's
bore pushed 0.4 mm toward the axis, 8 mm under the lip so the 12 mm radius reaches the rim and must not get over it: the outer surface is unchanged (5,584 outer vertices,
0 changed, bit-for-bit), the wall at the grab is **2.000 mm** (1.6 + 0.4), the grab moves
the full 0.4. With the toggle off the same push moves the outer skin 0.4 mm too - the wall
as one section. The 0.8 mm guard still applies: the outside of a 0.8 mm wall pushed 0.5 mm
into it is refused. The toggle is read when a grab begins, not mid-drag.

## Out of scope

Twisting, falloff shapes other than the bell, pulling across two pieces, and undo of
individual pins (Undo restores the piece; the pins are raw coordinates and stay).

## Files

`nso_densify.js`, `nso_pull.js`, `app-pull.js` (new, `?v=pull1`); `index.html` (button,
panel and its two controls, three script tags); `styles.css` (armed colour); `app-core.js` (the undo label,
the pointer ask beside the Brush's); `app-input-mode.js` (leave-tool); and the
mutual-disarm both ways in `app-brush.js`, `app-carve.js`, `app-center-lock.js`,
`app-lift-plate.js`, `app-mask.js`, `app-measure.js`.
