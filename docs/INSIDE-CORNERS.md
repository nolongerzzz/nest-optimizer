# Inside corners — the corners8 setback, taken into a pocket

Module: `nso_inside_corners.js` (parked, **not wired in**)
Suite: `node tools/nso_inside_corners_test.js` — 74 checks, all passing
Outputs: `tools/out/inside-corners/*.stl`, for `tools/mesh_validate.py`

Every number below is measured by that suite on synthetic fixtures. Nothing
here was read off a screenshot.

---

## 1. What the outer setback assumes about convexity

The ticket asked whether `rawVertexBallCorners` (corners8, `app-finish.js`)
generalises to a concave pocket interior, or needs a genuinely different
approach. It does not generalise, and it is not a sign flip. Three separate
assumptions, each one measured rather than argued:

### 1a. It cannot be pointed at a pocket face at all

`softenSelectedFace` asserts the clicked plane **is** the outer plane on its
axis, and refuses otherwise:

```
const extreme = rawExtremeOf(rawTris, axisIdx, keepMinFace);
if (pickPlane == null || ... || Math.abs(pickPlane - extreme) > FACE_PICK_TOL)
  throw new Error('clicked face is not the outer plane on that axis');
```

On the standard fixture (hull 40×30×20, pocket 20×12 × 10 deep through +Z),
every internal face is refused:

| picked face | outer plane on that axis | result |
|---|---|---|
| pocket floor z=10, min side | 0 | `clicked face is not the outer plane on that axis` |
| pocket floor z=10, max side | 20 | same |
| pocket wall x=10, min side | 0 | same |
| pocket wall x=30, max side | 40 | same |

Also: the **hull's own top face** of a pocketed brick is refused too, with
`R=2 leaves no face - left unchanged`. Its cap boundary is two loops (the
outer rectangle and the pocket mouth), and the engine walks one loop and
insets against it. So the per-face engines do not merely lack a pocket mode —
they cannot treat any face a pocket breaks through. `rawVertexBallOnly` fails
the same fixture differently: `vertex ball took the wrong bite out of the face`.

### 1b. It filters concavity out at the first gate, then refuses the face

```
if (turn[ai] * wind <= 0) { skipped++; continue; }
...
if (skipped) throw new Error('Corners+edges needs all ' + cornerCount +
  ' corners of this face free - ' + skipped + ' back onto something already softened');
```

Measured on an L-prism whose top face has five convex corners and one reflex
one, with the skip sites instrumented to report the real reason:

```
loop points = 6   corners detected = 6
loop index 3: concave: turn sign opposes the loop winding
-> THROWS: Corners+edges needs all 6 corners of this face free -
           1 back onto something already softened
```

**Worth fixing on its own:** that message is wrong. The corner was dropped for
being concave, not for backing onto softened geometry, and the message sends
the reader to look for a previous bake that does not exist. One reflex corner
anywhere on a face refuses the whole face, because the all-or-nothing rule
below the filter is deliberate (a partial treatment would inset edges that
carry no band). `rawVertexBallOnly` (corners5) does **not** refuse — it rounds
the five convex vertices and leaves the reflex one sharp, mid-edges square,
volume −1.167 mm³ at R=2.

### 1c. The blend is architecturally subtractive, and two-edged

Two deeper reasons a mirrored version would not be the same function:

- **Direction.** The engine clips the cap face and both walls back
  (`clipHalf(pc, 0, stripR, 0, 1)`) and stitches the blend into the volume it
  removed. Nothing in it can emit surface outside the original faces. Rounding
  a convex corner removes material; rounding a concave one **adds** it. The
  suite pins the sign: the pocket bake is `+53.305 mm³` at R=2, and the module
  refuses any bake whose volume went down.
- **Two edges, not three.** `b.tip3 = b.at(0, 0, R)` is "the knife end": the
  blend closes to a point on the *depth edge* where the two walls meet, and
  that edge stays sharp. Measured on a 20mm cube at R=2 — treated face
  perimeter edge: bite **0.8284 mm**; depth edge: bite **0.0000 mm**. A corner
  whose three edges are all rounded has no such point to close on, so
  "port the setback into `rawWrapSolid`" is not well posed either.

### 1d. So how the inside is actually reached

It does not need concave maths, because the shipped inside1…inside3
architecture already removes the need. The pocket is cut by a **plug**, and a
plug is convex. Run the **unmodified** engine on the plug's floor-end face,
then let the boolean mirror it inward. The engine only ever sees the convex
body it was written for, and the concave result is exact rather than
approximated.

That is all `nso_inside_corners.js` does. There is no new geometry maths in
it — the parts that are new are the plug framing, the gates, and the tests.

---

## 2. The bake, measured

Two probes carry the whole ticket, both bisected to 1e-3 mm and both
calibrated against closed forms in the suite itself:

- **bite depth** — from a sharp *convex* apex, how far along the into-the-body
  direction before the solid starts. `0` = still sharp.
- **fill depth** — from a sharp *concave* apex, how far along the into-the-void
  direction the solid still reaches. `0` = still sharp.

Calibration: a corners5 vertex ball on a 20mm cube at R=2 measures
**0.6357 mm**, against the closed form `Rc(√3 − √2) = 0.635674`. Exact to four
decimals, so a broken probe fails loudly rather than passing everything.

### Fixture: hull 40×30×20, one rectangular pocket 20×12 × 10 deep through +Z

| feature | before | after (R=2) | wanted |
|---|---|---|---|
| 4 pocket-floor vertices (fill) | 0.0000 | **1.2779** ×4 | round |
| 4 pocket-floor edges (fill) | 0.0000 | **0.8284** ×4 | round |
| 4 vertical wall edges (fill) | 0.0000 | **0.0000** ×4 | stay square |
| lid rim, 4 lines (bite) | 0.0000 | **0.0000** ×4 | stay sharp |
| hull top corners (bite) | 0.0000 | **0.0000** ×4 | untouched |
| triangles | 28 | 2336 (plug 2320) | |
| volume | 21600.000 | 21653.305 (**+53.305 mm³**) | material added |

The floor-edge figure is exact: the band is a radius-R cylinder tangent to
floor and wall, so the apex-to-surface distance along the 45° bisector is
`R(√2 − 1) = 0.828427`. Measured 0.8284.

The vertex figure identifies the surface as the **setback** and not a sphere.
A plain sphere blend would give `R(√3 − 1) = 1.4641`. Solving the setback
profile (`a = R(1−sin φ)`, `mc = R(1 − cos φ(1−sin φ))`, `r = R sin φ cos φ`)
for where the diagonal meets it gives φ ≈ 0.681, depth 0.7412, diagonal
distance **1.284 mm**. Measured 1.2779 — the 0.006 mm gap is the 12×12
tessellation, the same place the fillet mode's vertex reads 1.4677 against its
own exact 1.4641.

### Other pocket shapes

| fixture | floor vertex (fill) | wall edge (fill) | lid rim (bite) | volume |
|---|---|---|---|---|
| opens through −X, R=2 | 1.2779 | 0.0000 | 0.0000 | +35.958 mm³ |
| opens through +Y, R=1.5 | 0.9583 | 0.0000 | 0.0000 | +26.391 mm³ |
| two pockets, R=2 each | both round | — | — | +110.080 mm³ |

The −X case reads 1.2779, identical to +Z: the treatment does not depend on
which axis the pocket opens along. The +Y case at R=1.5 reads 0.9583 =
1.2779 × 0.75, so the blend scales linearly with R as it should.

An 8×4 mm pocket asked for R=5 is **clamped to 1.80 mm** (`0.45 × 4`) and says
so in its stats, rather than producing a blend wider than the cavity.

### The lid rim

`0.0000 mm` bite on every rim line of every fixture. **No logic near the mask6
both-faces rule was touched** — the rim stays sharp by the mechanism that
already ships: the plug is pushed `2R + 1` past its own mouth, so the treated
end is the pocket floor and the mouth end of the plug sits outside the hull
entirely. The rim goes on being the edge the hull face makes with the wall.
The suite asserts it as a named check on each fixture so a future change
cannot round it quietly.

### Watertightness and self-intersection

Every output, through `tools/mesh_validate.py` (the battery from the CSG
integration work, Möller tri/tri over a spatial hash):

| file | tris | volume | open | non-mf | odd | winding | euler | pierce | coplanar |
|---|---|---|---|---|---|---|---|---|---|
| pocket-before | 28 | 21600.000 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-inside-corners8 | 2336 | 21653.305 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-narrow-clamped | 1452 | 23759.253 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-opens-through-X | 1816 | 22115.958 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-opens-through-Y | 2648 | 20954.391 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-two | 4756 | 31358.080 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-wrap-corners | 2260 | 21598.862 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| pocket-wrap-fillet | 3868 | 21383.406 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |

`tools/stl_watertight_check.py --odd --degen` on the main result: `OK`,
2336 tris, 3504 unique edges, 0 open, 0 non-manifold, 0 odd, 0 degenerate.

---

## 3. No regression on the shipped inside3 path

Pocket detection is unchanged: `rawPocketBrick` still reads the fixture as
`plo [10,9,10] phi [30,21,20] mouthAxis 2 mouthSide 1`, and `rawBoxPockets`
still returns one pocket with its five faces.

The face-selection report — which of the 11 faces bake and which stay square —
is unchanged, driven through the shipped `brickSkipLists` router exactly as
`wrapPocketBrickRun` calls it:

| painted | reported |
|---|---|
| nothing | hull 6/6, pocket 5/5, 11 of 11 baked |
| hull top | hull 5/6, pocket 5/5, 10 of 11 baked |
| pocket wall x=10 | hull 6/6, pocket 4/5, 10 of 11 baked |
| both | hull 5/6, pocket 4/5, 9 of 11 baked |
| pocket floor | hull 6/6, pocket 4/5, 10 of 11 baked |
| a plane the soup does not carry | refused, piece left alone |

And the paint drives the geometry, not just the status line. Painting the
pocket wall x=10 takes exactly the two floor vertices **on** that wall to
0.0000 fill while the other two still read 0.6369 — the both-faces rule
visible as a number.

### This is an additional pass, not a competing one

Three distinct shapes on the same pocket at R=2:

| | floor vertex | floor edge | wall edge | lid rim |
|---|---|---|---|---|
| shipped wrap `corners` | 0.6369 | 0.0000 | 0.0000 | 0.0000 |
| shipped wrap `fillet` | 1.4677 | 0.8284 | 0.8284 | 0.0000 |
| **this module** | **1.2779** | **0.8284** | **0.0000** | **0.0000** |

`corners` rounds the pocket's vertices and leaves every pocket edge square;
`fillet` rounds all twelve edges. Neither can express corners8's shape — the
clicked face's perimeter rounded, the depth edges left sharp — which is what
this adds. All three leave the lid rim sharp.

---

## 4. Findings that land on code this ticket did not change

Each wants its own scoped pass and an explicit **APPLY**. None touched here.

1. **`rawWrapSolid` has no setback branch.** `mode === 'corners'` takes the
   ball path and *everything else* — `fillet`, `chamfer` and **`cornersedges`**
   — falls into the offset-of-the-shrunk-box branch. So in the whole-solid wrap
   path, "Corners+edges" and "Round" are the same geometry, on the hull as well
   as the pocket: identical triangle count (3868), identical volume
   (21383.405746), identical surface area, identical probes. In the per-face
   path they are two different engines. A user picking Corners+edges on a
   wrapped piece is silently getting Round. The suite pins this so a fix trips
   it.

2. **`rawVertexBallOnly` emits backwards-wound triangles.** Its plug bake is
   0 open / 0 non-manifold by `nsoSealScore`, and `mesh_validate.py` finds
   **72 inconsistently wound triangles**; Manifold refuses it outright with a
   bare `Not manifold`. This is HANDOFF finding 2 with a reproduction: the
   app's coordinate-rounding edge counters weld undirected edges, so a
   reversed face pairs every edge and reads clean. `NSO_insideEdgeScore` in
   this module counts **directed** edges and sees it (`stacked: 72`), which is
   why the module refuses a corners5 plug with a real reason instead of
   passing the kernel something it will reject. Consequence: the corners5
   recipe cannot be taken inside by this route until that winding is fixed.
   Not a gap in practice — shipped `rawWrapSolid` `mode='corners'` already
   gives a pocket vertex-only rounding correctly (0.6369 fill, edges 0.0000).

3. **`rawBoxPockets` misses pockets that share a face plane.** It groups
   triangles by plane (axis, sign, offset), not by connectivity, so two
   pockets with any coplanar face merge into one cluster that is not a box and
   **both are dropped**. Measured on a 60×30×20 plate with two 18×12×10
   pockets: floors and walls coplanar → **0 found**; floors 2 mm apart but
   walls still coplanar → **0 found**; every face plane distinct → 2 found.
   Two identical bays side by side at one depth is the common case and the
   router finds neither. Shipped inside1 code; pinned by the suite.

4. **The setback's refusal message names the wrong cause** for a concave
   corner (§1b). One-line fix, but it is inside `rawVertexBallCorners`, which
   is live on the corners8 path.

---

## 5. State, and what is not done

Built and measured; **not wired into the UI**, same as repair / sculpt /
planar fuse. Wiring means a new edge treatment in `getEdgeTreat` and a control
in `index.html`, which is a surface change and Grok's call — and `?v=` is not
bumped here.

Not done, deliberately:

- **Non-box pockets.** The module reads the two box-pocket shapes the app
  already produces and refuses anything else, rather than guessing.
- **The mouth end of the plug.** Only the floor end is treated. A treatment
  that reached the mouth would round the lid rim, which is the boundary the
  ticket flagged as deliberate.
- **Nothing near mask6.** The paint / skip-list logic is read-only from here.
  Applying the paint's skip list to *this* bake — so a painted pocket wall
  leaves its two floor vertices sharp, the way it already does for the wrap
  modes — is the obvious next step and needs a decision on wiring first.
