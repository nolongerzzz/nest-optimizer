## Inside corners — the corners8 setback in a pocket (landed, `nso_inside_corners.js`)

Full write-up with numbers: `docs/INSIDE-CORNERS.md`. Suite:
`node tools/nso_inside_corners_test.js` (101 checks). **Not wired in** — no
script tag, no `getEdgeTreat` option, `?v=` NOT bumped.

The ticket asked whether corners8's setback generalises to a concave pocket.
It does not, and the answer is measured, not argued: `softenSelectedFace`
refuses every internal face outright (`clicked face is not the outer plane on
that axis`); `rawVertexBallCorners` drops any corner whose turn opposes the
loop winding and then refuses the whole face; and the blend is subtractive and
two-edged — it closes on a point on the depth edge, which it leaves sharp.

It does not need to generalise. The pocket is cut by a **plug**, and a plug is
convex, so the unmodified engine runs on the plug's floor end and the existing
boolean mirrors it inward. No new geometry maths.

On the standard fixture at R=2: pocket-floor vertices fill **1.2779 mm**, floor
edges **0.8284 mm** (= R(√2−1), exact), vertical wall edges **0.0000**, lid rim
**0.0000**, +53.305 mm³, watertight, 0 self-intersections on
`tools/mesh_validate.py`. inside3's face reporting is unchanged on all six
paint cases, and the paint still drives geometry: painting the pocket wall
x=10 takes exactly its two floor vertices to 0.0000 and leaves the other two
at 0.6369.

**The mask6 both-faces rule was not touched.** The rim stays sharp by the
mechanism already shipping — the plug is pushed 2R+1 past its own mouth, so
only the floor end is treated.

Follows the standing paint rule at the top of this file: `opts.skip` is a
required argument, and painting the pocket floor or any of its four walls
stands the bake down and names the face. The status line is the shape the three
wired bakes adopted — `Pocket corners stood down - N painted face(s); …`,
matching `Smooth stood down - N painted face(s); …` and `Repair stood down -
N …` — and the result carries `painted` as the count with the detail under
`paintedFaces`.

One deliberate difference from that trio: Smooth / Repair / Fusion are
whole-piece operations with no skip list, so ANY paint on the piece stops them
(`nsoMaskCount(m) > 0`). This one knows which faces it touches, so it counts
only the pocket floor and its four walls. Paint on the pocket mouth, or
anywhere on the hull, does not stop it — this treatment never reaches those,
and the resulting bake still measures correct. A painted
wall stops the *whole* bake rather than leaving that one edge square, because
`rawVertexBallCorners` has no per-edge radius and its own rule is
all-four-corners-or-none; giving the setback a per-face radius the way
`rawWrapSolid` has one is a change to live corners8 code and wants its own
ticket and an APPLY.

Three findings land on code this ticket did NOT touch. Each is someone else's
gate and wants its own scoped pass and an APPLY:

1. `rawWrapSolid` has no setback branch — `mode === 'corners'` takes the ball
   path and everything else, **`cornersedges` included**, falls into the
   offset-of-the-shrunk-box branch. So in the whole-solid wrap, Corners+edges
   and Round are the same geometry on hull and pocket alike: identical tri
   count 3868, identical volume 21383.405746, identical probes. In the
   per-face path they are two different engines.
2. `rawVertexBallOnly` emits **72 inconsistently wound triangles** on a plug
   bake that `nsoSealScore` calls 0 open / 0 non-manifold; Manifold refuses it
   as a bare `Not manifold`. That is finding 2 above with a reproduction.
   `NSO_insideEdgeScore` counts directed edges and sees it.
3. `rawBoxPockets` groups faces by PLANE, not connectivity, so two pockets
   sharing any face plane merge into a non-box cluster and **both are
   dropped**. Two identical bays side by side at one depth → 0 found. Every
   face plane distinct → 2 found.

Also one-line and live: the setback's refusal message blames "something
already softened" for what is actually a concave corner.
