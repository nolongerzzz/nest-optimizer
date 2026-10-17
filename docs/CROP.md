# Crop: remove a slab and rejoin (stage 1), move a region (stage 2)

`app-crop.js`, loaded right after `app-mirror.js`. It uses Cut's raw clip
(`app-cut.js`) and the sculpt commit (`app-sculpt.js`), and does not copy
either of them.

```
node tools/nso_crop_test.js        headless: canonical checker on every result, refusals, box -> faces
node tools/nso_wire_crop_test.js   the real app: the Cut-menu row, the box drag, commit, export, undo
node tools/nso_crop_engine_test.js the copy engine (Stage 4, below): shapes, Outline, refusals, the plate
```

Both are in `npm test` (`crop:test`, `wire:crop`).

## What it does

A box selects a slab of the piece along the cutter's axis. Crop removes
everything inside the box. The part past the box slides back along that axis
by the box length, so it meets the near part at the near box face. The joint
is then sealed, and the result is **one closed piece, shorter by exactly the
box length**.

That slide belongs to "crop out a middle section". It is not a repositioning.
Nothing moves sideways or turns, and the near part does not move at all. Two
sections that do not line up (a lateral offset, a twist) are **Stage 2**.

## What is reused

| step | reused from | how |
| --- | --- | --- |
| clip at each box face | Cut: `rawCutOpen` (`app-cut.js`) | `rawCut` is now `rawCutOpen` plus the cap, so Cut and Crop run the same seam-safe clip: weld input, snap near-plane vertices onto the plane, clip, weld the on-plane points on float32 positions |
| cap for a step face | Cut: `rawFlatCapLoop` / `rawEarClip2D` | fed one loop, the same way `rawCut` feeds it |
| zero-area clean-up | Cut: `rawSplitDegenerates` | |
| joint-point weld | Cut: `rawWeldPoints` | 2 x the weld radius, as `rawSnapPlanePoints` does for one cut |
| commit + undo | `NSO_sculptCommitRaw` | undo type `cropReplace`, "Undo: Crop reverted" |
| result gate in the app | `NSO_Repair.inspect` | the in-page canonical census Solidify already gates on |
| plane mapping | `resolveAxis`, `mapPlaneToRaw` | the box runs along the red line's axis and is measured from the same low end |

## Why the joint is sealed here and not by Join

Measured before writing any of this. First, `rawCut` capped both pieces:

- **Join's planar fuse (`NSO_planarFusePair`) refused a plain bar** with "no
  congruent triangle found". Each wall quad is two triangles. Its diagonal
  crosses the two box faces at different points, so the two sections have
  the same outline but different vertices on it, and the fuse needs identical
  cap triangles. `nso_crop_test.js` §1 keeps this as a baseline check.
- **The Manifold union (`NSO_unionSoups`) did not fail cleanly.** It passed
  on pin, the slotted block, the star prism and the hinge. It left
  `box_closed.stl` and `v9_mirror_factory.stl` non-manifold with inconsistent
  winding by `tools/mesh_validate.py`.

So `NSO_cropSeal` works on the two open boundaries directly, once both lie in
one plane:

1. **Weld** the joint points of both parts together.
2. **Split** every open boundary edge at each joint point lying on it
   (T-junctions) and at each crossing with the other part's boundary. The wall
   triangle that owns the edge is fanned from its off-plane corner. Where the
   sections match, every edge now has a reverse twin and the walls run
   straight through. No cap is built.
3. **Cap only the step faces.** An edge that is still open borders either the
   near section outside the far one (a step facing +axis) or the reverse
   (facing −axis). Each edge is classed by its midpoint, the edges are walked
   into loops per class, and each loop goes to Cut's `rawFlatCapLoop`. Where
   two step faces of one class touch at a point, the walk keeps to the face
   it is on.

Then the result is gated on the float32 values it will be saved as:

- every directed edge occurs once and its reverse once (closed, manifold,
  consistently wound)
- nothing is degenerate
- the enclosed volume equals the two kept parts' volume. That volume is
  computed with no cap at all, as the flux of `(x_k − c)·e_k` over each
  part's walls, which is zero across its open face.

A triangle lying in a box face after the clip (a flat face of the piece the
box lands on exactly, or seam slivers snapped onto the plane) faces the
removed side. `rawSnapPlanePoints` keeps only those, and they are already cap,
so Crop takes them out and seals the section like any other.

## Results

`tools/mesh_validate.py`, the canonical checker, on every result:

- **the simple test piece**: a 60 × 12 × 8 bar with X 25..35 cropped out. The
  result passes with self-intersection included, is one shell, measures
  exactly 50 × 12 × 8 and encloses exactly 4800 mm³. Both kept parts are there
  bit for bit, the far one exactly −10 in X. Through the real app, both the
  kept `rawTris` and the exported STL pass, and `stl_watertight_check.py`
  agrees.
- **stepped bar** (12 × 8 then 12 × 4), both ways round: one step face of
  48 mm², facing +X or −X as it should, volume 2880 exactly.
- **tube**: the section is an annulus. The sections match, so no cap is
  needed; the result is still a tube (χ 0), 20/25 of the volume.
- **library**: pin, slotted block, star prism, hinge, CTH fixture and
  `v9_mirror_factory.stl`. The v9 cases include a box ending exactly on each
  Mirror-Join seam ring, one through the +seam's sub-tolerance pair, and one
  with crossings at the joint. Every result passes, and its volume matches
  the flux. Where rawCut's own capped halves pass the checker, it also
  matches their sum.
- **v9 sweep** (not in the suite, run while building this): 328 boxes over
  `v9_mirror_factory.stl`, 1, 7, 23 and 60 mm wide, stepped every 2 mm along
  X. 263 were cropped and **all 263 pass** the checker (0 fail). The other 65
  were refused by name, all for the same reason: a step face that would need
  a hole. None came back ok-but-broken.

## Refusals

Each refusal names its reason and hands back the input soup object untouched:

| refusal | why |
| --- | --- |
| box not strictly inside the piece | that is a trim; use Cut |
| box does not cover the whole cross-section | that would be a pocket, which is Carve's job |
| step face would need a hole | Cut's cap fills simple outlines only. Example: hinge X 5.4..9.9, where the far section is a square with a bore and the near section a 2 mm strip, so the step face goes around the bore |
| the two parts overlap along the joint | the input has overlapping shells (`box_closed.stl`, 74 piercing pairs in the source) |
| painted faces (app) | whole-piece paint scope, as Extend: everything past the box slides |
| raw frame no longer matches the view (app) | the piece was turned (yaw) since it was loaded |

## Known limits, for the next ticket

- **A step face with a hole.** It needs a bridged-hole cap. Cut now has
  one: `rawFlatCapLoops` (app-cut.js) classes a section's loops by nesting
  and bridges each hole into its outline, which fixed `rawCut` mis-capping a
  section with a hole (tube, hinge knuckle; `tools/nso_rawcut_bore_test.js`).
  Crop still caps each step-face loop with `rawFlatCapLoop` and still
  refuses a step face with a hole; switching it to `rawFlatCapLoops` is the
  follow-up that would lift that refusal.
- **Stage 2: repositioning.** Now below: [Stage 2](#stage-2-move-a-region-and-reconnect-it).
- **Self-intersection is inherited, not repaired.** On
  `tape_on-edge-single-B101_rounded_v8_FINAL.stl` the source already has 185
  piercing pairs, and a crop keeps them.

## UI

The Crop card (its own card in the left column, under Cut; it was in the Cut
menu, under Split, until Cut and Crop were split). Opening it arms the piece
selection for Crop, with no blade. **Crop X** / **Crop Z** pick the axis the box
runs along, as Cut X / Cut Z did for Crop before (unset: the longer of X and Z).
**From** and **to** are millimetres from the piece's
low end along the cut axis, the same frame as the red-line readout. They
default to the middle fifth. The readout shows the new length and how many
faces the box removes or clips. Tick **Box** to draw the box on the piece:
drag its body to slide it, drag an end face to move that end. Crop is live
while the cutter is open on a piece.

# Stage 2: move a region and reconnect it

`app-crop.js` sections 4b (headless) and 5b (the app). Same file, same box,
same clip, same seal.

```
node tools/nso_crop_move_test.js        headless: every branch, every refusal, the v9 acceptance test, canonical checker
node tools/nso_wire_crop_move_test.js   the real app: region fields, Lift, ghost drag, Lock in, export, undo
```

Both are in `npm test` (`crop:move`, `wire:crop-move`).

## What it does

The Crop box selects a **region**: any box, not only a full slab. Two more
pairs of fields narrow it across the section (Up, Across). Cut's clip takes
the region out. It is moved by an offset, in any direction, and nothing
changes until **Lock in**. Then the moved region is measured against the
rest of the piece, and that measurement picks the reconnection:

| measured after the move | branch | how |
| --- | --- | --- |
| they overlap | **trim** | `NSO_unionSoups`: the overlap is removed |
| face to face, no overlap (< 0.001 mm³) | **touch** | the same union |
| apart, gap ≤ 3 mm | **bridge** | a closing of the two parts fills the gap with a filleted bridge, unioned with both |
| apart, gap > 3 mm | refused | names the measured gap and the reach |
| > 90 % of the region inside the rest | refused | the region would vanish into the piece |
| the piece would end up in more parts than it had | refused | names the count |
| the result fails the gate | refused | names the checker's numbers |

The offset the user typed never decides the branch. `[0, 31, 0]` and
`[0, 31, -2]` on the acceptance piece differ by 2 mm and land in different
branches because of what is under them.

## The audit that came first

**`NSO_CSG` / `NSO_unionSoups` for the overlap: reused, confirmed.** It runs
headless through `tools/nso_csg_node.js`, the shipped adapter spliced out of
`app-join.js`. On v9 it does what it should and one thing it should not:

- A union far from anything leaves the piece alone: 39,228 of 39,230 far
  triangles kept exactly. The other two are the +seam's sub-tolerance pair,
  which the union's input weld merges.
- A union whose intersection is flat on flat is clean.
- A union whose intersection crosses the Mirror-Join's seam-to-seam sliver
  fans (the lip's rounded end on the rounded tooth tops) leaves vertices
  closer than 1e-4. The checker welds them into non-manifold edges: 46 and
  115 inconsistent on the first landing tried, 2 → 78 on another. That is
  the seam-cap defect class rawCut had (docs/MIRROR.md), met by a boolean
  instead of a clip.

**Hollow's surface nets for the gap: reused, not copied.** `nso_hollow.js`
now exports `edt3d`, `surfaceNets` and `tidyCavity` (as `tidyPositive`), and
the bridge calls them. The bridge is not Hollow's field, though. Hollow
erodes one solid. The bridge is a **closing** of two (dilate by r, then
erode by r), kept only within g + r of both parts:

- Where the parts face each other across less than 2r, the closing fills
  the gap and rounds its edges with radius r. Anywhere else it is just the
  two parts, and the mask drops it.
- It reaches r into each part, so the union has volume to grip, not a face
  to balance on.
- r = max(0.6 g, g/2 + 2 pitch, 0.4 mm). The pitch is g/3, clamped to
  0.08 .. 0.15 mm.
- Occupancy is parity on +Z rays, via `NSO_Thickness.prepare().hitsAlong`.
  The rays start below both parts, not below the grid, because the grid can
  begin inside a part.

## What is reused

| step | reused from |
| --- | --- |
| the region | Cut's `rawCut` at each box face that crosses material (the clip Stage 1 uses) |
| the slab the kernel works on, and the parts outside it | `rawCut` / `rawCutOpen` |
| the notch the region leaves | `NSO_subtractSoups` (a box solid from the slab) |
| trim / touch | `NSO_unionSoups` |
| the gap | `NSO_Thickness.prepare().nearest`, vertex to surface both ways |
| the bridge field | `nso_hollow.js`: `edt3d`, `tidyPositive`, `surfaceNets` |
| splicing the slab back | Stage 1's `NSO_cropSeal`, after the slab's caps are taken out |
| the weld | Cut's `rawWeldSoup` at `RAW_CUT_WELD_TOL`, then `rawSplitDegenerates` |
| the gate | the exact edge census, the volume, and `NSO_Repair.inspect` (the in-page checker) |
| commit + undo | `NSO_sculptCommitRaw`, undo type `cropMove`, "Undo: Move reverted" |

## Where the kernel runs: a slab, not the piece

Only a slab along the cut axis goes through the kernel. It holds the notch,
the landing and room for a bridge: 1.6 × the bridge reach plus 1.5 mm on
each side. A side that would reach the end of the piece is not cut.

The slab is cut out capped. After the reconnection its caps are dropped, and
it is sealed back into the two untouched parts with Stage 1's own seal. The
seal must find the sections identical: no step face. Otherwise it refuses.

Outside the slab, every vertex is Cut's clipped half's. On v9 that is 128,695
of 128,695 source vertices kept exactly next to the +seam, and all but the 6
of the sub-tolerance pair next to the −seam, which Cut's own weld merges.

## Nothing under the checker's weld is left for it to misread

Two places, both measured on v9:

- **The region is re-meshed before it moves.** `Manifold.simplify` at
  1e-4 takes the lip from 1370 triangles to 100, −0.0075 mm³, and takes the
  sliver fans with it. Without that, Cut's clip leaves two fan triangles
  near-coplanar with no shared vertex. The checker's float triangle test
  calls that pair piercing, which is the "checker limit" in docs/MIRROR.md.
  Exact rational arithmetic shows them disjoint: one lies wholly on one side
  of the other's plane, 1e-10 .. 3e-7 mm off it. The region is a closed
  piece on its own until lock-in, so re-meshing it breaks no outline.
- **The reconnected slab is welded at Cut's radius.** It is not simplified.
  `simplify` on the slab was tried and it collapsed a vertex on the slab's
  cap outline, so the splice at X 92.3065 found a 3-edge step face. The
  weld alone leaves the outline alone, because rawCut already welded its
  on-plane points at twice the radius. Without the weld, the bridged lip
  comes out non-manifold 2 → 4, from surface-nets vertices that round
  together in float32.

## The acceptance test: v9_mirror_factory.stl

The −Y lip (Y −17..−2, Z 7.5..10.5) boxed out to Y −3 over X 74..86, 1.5 mm
short of the +seam ring at X 87.537. It is moved to the mirror-opposite +Y
side, same X. On that side the body tops out at the teeth, Z ≈ 6.3.

| move | branch measured | result |
| --- | --- | --- |
| +31 Y, own height | **bridge**: 0.897 mm gap, +6.22 mm³ | PASS, self-intersection included |
| +31 Y, 2 mm down, into the teeth | **trim**: 11.54 mm³ overlap | PASS, self-intersection included |
| box far face exactly on the +seam ring, own height | bridge: 0.895 mm, +6.51 mm³ | PASS |
| the same, 2 mm down | trim: 11.90 mm³ | PASS |
| the same span next to the −seam, 2 mm down | trim: 11.54 mm³ | PASS |
| +31 Y, 6 mm up | refused: gap 6.90 mm | input handed back |
| −10 X, +15 Y, −14 Z, into the body core | refused: 96 % buried | input handed back |
| +80 Y | refused: gap over 10 mm | input handed back |

The source fails the checker on its own: 2 non-manifold and 5 inconsistent
edges, all at the seams, where the +seam's sub-tolerance pair sits on the
lip's underside. Every result above passes with 0 defects. So the seam-cap
class is not reintroduced: the result has nothing within either seam ring,
and Split through the +seam ring (X 87.537), through the landing (X 80) and
through a slot wall (X 77.3) gives two passing halves each time. Volume is
accounted to 0.001 mm³: source − notch + region − overlap + bridge + what the
weld moved. The notch (by the kernel) and the region (by the clip) differ by
0.03 mm³, because Cut's clip snaps vertices within 1e-4 of a box face onto
it.

Why a single move exercises one branch, not both. "Gap-bridging where it
left, overlap-trimming where it lands" is two moves at one location here. The
region reconnects once, to whatever it lands against, and that contact is
either an overlap, a touch or a gap. Where it left, the notch is closed by
the subtraction itself: flat faces on the box planes.

On the tabbed bar (60 × 12 × 8 with a 10 × 6 × 4 tab), where every number is
hand-computable: touch encloses exactly 6000, trim 5960 and 5880, a 1 mm gap
measures 1.000 mm and bridges, a 0.3 mm gap measures 0.300 mm and bridges.
All pass with self-intersection included.

## UI

Crop card, under Crop:

1. **From / To** as before set the span along the cut axis.
2. **Up** and **Across** narrow the box across the section. They are mm from
   the piece's bottom, or its low side on the other horizontal axis. Blank
   means the whole of it.
3. Tick **Lift**. The region is drawn as an amber ghost.
4. Drag the ghost. It moves in the plane facing the camera, so turn the view
   and drag again to reach any point in 3D. Or type **ΔX ΔY ΔZ** (display
   axes, Y up).
5. **Lock in** runs the reconnection. The status line says which branch was
   measured, and by how much.

Undo reverts it. A painted piece stands down (whole-piece paint scope, as
Crop).

Lock in takes 2–7 s on v9: most of it is the kernel, and the bridge field
when there is one.

## Limits

- **The box keeps Stage 1's clamp along the axis.** A region cannot include
  the very end of the piece.
- **One contact per move.** The branch is decided once, for the whole
  region. A region that overlaps the rest in one place and hangs 1 mm clear
  of it in another is trimmed where it overlaps and not bridged elsewhere.
- **No rotation.** The offset is a translation.
- **The bridge is sampled.** At 0.08 .. 0.15 mm pitch, the fillets are
  facetted at that pitch, most visibly where a neck meets a curved part at a
  grazing angle. The union with the exact parts fixes where it meets them.
  Taubin smoothing of the bridge mesh was tried and taken out. It softened
  the stairs only a little, and it gave the tabbed-bar bridge one
  self-intersecting pair.
- **Crossing both seams is not tested yet.** A region spanning the whole
  lip, across both seam rings, is the next stress test.

# Stage 3: Circle and Piece

Two regions beside the Box (`app-crop.js` sections 6 and 7). Neither removes
a slab or slides anything. The region is a cutter standing upright through
the whole piece, and the piece keeps what is inside it or what is outside it.

| Region | Cutter | Controls |
|---|---|---|
| **Circle** | a cylinder, axis vertical as the piece lies | Click centre, then press on the piece and drag out (Ø = twice the drag), or type Ø. Drag the drawn circle's middle to slide it, its rim to resize it. |
| **Piece** | another piece's outline seen from above (its silhouette, vertical walls), where it sits on the plate | Pick piece, then click the template. Grow (mm, default 0, + wider / − narrower, round corners). |

Both have **Keep inside** / **Keep outside** and one **Crop** button. The
template piece is read, never changed.

## How

`NSO_cropShapeRaw(rawTris, { shape, keep, toRaw })`, headless and async:

1. The cross-section is the kernel's own `CrossSection`. The circle is a
   regular polygon whose chords sag at most 0.005 mm inside the true circle
   (124 sides at Ø30). The outline is the union, under the non-zero rule, of
   the template's triangles dropped straight down. That is the silhouette
   whatever the template's own topology. Grow is the CrossSection's round
   offset (256 segments a turn).
2. It is extruded through the piece's whole height plus 1 mm each way.
3. It is built in the plate frame P (z up) and moved onto the piece's raw
   soup by one transform, P to raw through the mesh as drawn. The piece's
   own vertices are never moved or re-rounded, and a piece turned on the
   plate is cut where it is seen. A raw soup that no longer matches its mesh
   (turned since it was loaded) is refused, as the Box refuses it.
4. Keep inside is `intersect`, Keep outside is `subtract`. The result is
   gated by the exact-key edge census here, then by the in-page checker
   before the commit.

The bake recentres the piece's frame on what is left, which would move a disc
cut off-centre to where the plate's centre was. So the placed entry is slid
back by that shift, and the Undo entry carries the pose it had (`prevPose`).
One Undo puts back both.

## Refusals

Each one is in words. The piece is unchanged and no Undo step is added.

- the region misses the piece: none of it is inside, or Keep outside would
  remove nothing;
- the region holds the whole piece (Keep inside would change nothing), or
  covers it (Keep outside would leave nothing);
- Grow shrinks the outline to nothing; the template has no outline from
  above;
- the template is the piece being cropped (refused at the pick);
- the kernel will not take the piece as a closed solid, or the result is not
  closed.

Paint scope: **whole-piece**, as the Box. The kernel rebuilds the whole
piece, so any paint stands the crop down.

## Results (`npm run crop:shapes`, 71 gates)

Through the real app. The checker is `tools/mesh_validate.py` with
self-intersection included.

| Case | Result |
|---|---|
| Circle Ø30, keep inside, 60 x 60 x 4 plate | Every vertex 15.0000 mm from the centre. 30.0000 x 30.0000 across. Volume within 0.05% of π·15²·4. Closed, χ 2. Stays where the circle was. |
| Circle Ø30, keep outside | Outside still 60 x 60. Every bore vertex 15.0000 mm from the centre. χ 0 (a hole through). Volume = plate − disc. |
| Piece: 100 x 100 x 3 plate to the star prism, laid over it off-centre | Every result vertex on the star's outline, and every point of the star's outline on the result's, worst 0.00000 mm. Volume = star area x 3. The star is untouched. |
| Grow 2 | Every result vertex 2.0000 mm outside the star's outline. Edges sampled 2.0000. 2.000 mm past the star on all four sides. |

The star's outline is computed by the test from the two meshes as drawn, in
the plate's raw frame, and not by the app's code. At the star's notches the
grown edge is two offset lines meeting, 2.44 mm from the notch itself. So the
star-side check is "no closer than 2", and the result-side check is "exactly
2".

## Limits

- **Circle and Piece cannot be lifted and moved** the way Move moves a boxed
  region. Their "slab-move" controls are the drags on the drawn circle.
- **The cutter is vertical.** Its axis is the plate's up, whatever the
  piece's pose. There is no tilted cylinder.
- **The template is used where it sits.** Put it over the piece (drag it,
  Center lock) before Crop. The outline is taken as drawn at that moment.

# Stage 4: the copy engine (`nso_crop.js`)

Crop is becoming one operation: **copy what a shape holds out of a piece, as a
new, sealed, solid piece on the plate.** The original is read and never written -
no cut, no cap, no repair - and comes out byte for byte as it went in. This is
the engine for it, on the Manifold kernel (the one Circle and Piece already
used). The card is the next ticket: until it lands the old card keeps working,
and its Circle and Piece regions now run on this engine.

```
NSO_Crop.plan(piece, shape)  -> Promise<{ ok, faces, volumeMm3, bbox, text }>   builds nothing
NSO_Crop.run(piece, shape)   -> Promise<{ ok, tris, faces, volumeMm3, bbox, ... }>   the closed mesh
NSO_Crop.copy(model, shape)  -> Promise<{ ok, id, name, ... }>                  run + onto the plate (browser)
```

Either of the first two answers `{ ok: false, reason }` and nothing else. The
only refusals are a shape that **holds nothing** of the piece and a result that
is **not closed**, plus numbers that make no shape (a box with a negative
half-size, a rim with no triangle) which are refused in words before the kernel
is touched. A shape that holds the whole piece is a copy of the whole piece.

## The piece, the frames

`piece = { name, rawTris, toRaw }`. `rawTris` is the piece's soup in its raw
frame. `toRaw` (16 numbers, column-major) maps the plate frame **P** - z up,
the way the piece stands - into that raw frame; omitted, P is the raw frame.
Every shape is given in P, where the user sees it, and moved onto the soup by
that one transform. The copy comes back in the piece's raw frame, so the same
`toRaw` puts it exactly where the original is.

## The shapes

All placed and sized freely in 3D: centre, half-sizes, yaw (degrees about the
vertical, counter-clockwise from above). There is no X / Z axis choice.

| shape | fields |
|---|---|
| box | `{ kind: 'box', c: [x,y,z], h: [hx,hy,hz], yaw }` |
| cylinder | `{ kind: 'cylinder', c, r, hl, axis: 'x'\|'y'\|'z', yaw }` (radius `r`, half-length `hl`; axis defaults to z) |
| sphere | `{ kind: 'sphere', c, r }` |
| piece | `{ kind: 'piece', source }`: another piece is the cutter; the copy is where the two overlap |
| outline | `{ kind: 'outline', source, mode, tri, d1, d2, z1, z2 }` |

`source` is a plate-frame soup or a piece-like `{ rawTris, toRaw }`, and may be
the very piece being cropped. Circles are polygons whose chords sag at most
0.005 mm inside the true circle; a sphere is cut twice as finely (its error runs
both ways, and 128 segments is the floor).

### Outline

The footprint **F** of a chosen piece, extruded between heights `z1` and `z2`
(omitted: right through the piece being cropped).

- `mode: 'silhouette'` (the default): the piece seen from above. A tube's is an
  annulus - you can see through its bore.
- `mode: 'rim'`, with `tri` a triangle index of the source: the edge loop that
  triangle borders, projected onto the plate. The triangle's smooth face is found
  by walking out across edges that bend less than `creaseDeg` (30); its loops are
  the crease / open edges round it. A triangle with an edge on one of the loops
  takes that loop (so on a tube's end face the outer triangles pick the outer rim,
  the inner ones the bore); any other triangle takes the face's outermost loop.

The offsets are distances, never negative. **d1** grows F outward, **d2** shrinks
it inward, and the region is the band between: `(F grown by d1) minus (F shrunk
by d2)`. d1 alone is a skin outside the footprint, d2 alone a skin inside it, both
a ring across it. **d1 = d2 = 0 is F itself, exactly** - no offset is applied, so
the cutter's walls are the source's own outline to the last bit. (A band of no
width would hold nothing, so zero on both is read as "the whole outline".) A d2
wider than F leaves nothing to subtract, so the band is all of F. `solid: true`
keeps the whole grown (d1) or shrunk (d2) footprint instead of the band - the old
card's Grow.

## The checks

On every `run`, before it says ok:

1. **Closed**, on the float32 values it will be saved as: every directed edge once
   and its reverse once (closed, manifold, consistently wound).
2. **Closed after the weld** every other tool applies, at the canonical checker's
   radius (1e-4 mm). Two polygonal surfaces that cross almost exactly at a vertex
   leave an edge of a few micro-millimetres: the first census passes it, and the
   weld shuts it into a non-manifold pinch (`mesh_validate.py` fails it).
3. **No slivers**: no edge under 2e-4 mm. If there is one, the kernel's `simplify`
   is tried at 2e-4, 5e-4, 1e-3, then an edge collapse by weld at 1e-4 and at 2e-4,
   and the cleanest result is kept. One that still fails (2) is refused as not
   closed. Loose parts under 1e-6 of the copy (the film a cutter wall leaves where
   it grazes a face) are dropped and counted; a void inside the piece stays.

## Onto the plate (`NSO_Crop.copy`)

The copy is a model of its own, **`<name> crop N`** (N is one more than the highest
already there), in `state.models` and on the plate, with the raw triple the raw
engines take. It is built in the original's raw frame and centred on its own
bounding box, so it lands where it was cut from the way Split to parts puts each
part back: the original's pose carried by the difference of the two centres, and
the height it was cut at kept (`liftY`). It is **selected**, so Move and the arrow
keys act on it at once - it overlaps the original, so a click would be a coin
toss. One Undo (`addModels`) removes it. `{ pieceId }` in place of `source` reads
a piece on the plate as drawn.

PAINT SCOPE: **none**. Nothing is written to the original, so there is no
sub-region and no whole-piece bake to stand down for; the copy carries no paint.

## Results (`npm run crop:engine`)

Volumes are checked against an oracle that shares nothing with the kernel: vertical
rays through the piece's mesh against the **ideal** shape (a true circle or
sphere, not its polygon), even-odd, on a grid offset so no ray runs along an edge.
Exact identities back it where they exist.

| case | result |
|---|---|
| box (plain, yawed), cylinder (x, y, z, yawed), sphere on the hinge and a stock tube (R12 r8 h20) | closed, no slivers, within 0.5% of the oracle (worst 0.30%), original byte-identical, `mesh_validate.py` clean with self-intersection |
| the hinge cut in two and added back; a box round all of it | 318.048 + 318.048 = 636.096 exactly; the whole hinge, 730 faces |
| a posed piece (`toRaw`) | the shape is where the piece is seen; every vertex of the copy lies inside the box seen through the pose |
| Piece: the tube across the hinge | within 0.1% of the oracle; the same cutter given with its own pose is the same copy |
| Outline: a tube's rim at offsets (0, 0.8) | the wall ring, 1165.93 mm³ against the closed form 1166.16 (0.02%), and 1165.93 on the 96-gon's own polygon |
| Outline: the bore's rim, (0.8, 0) and (0.8, 0.8); (0.5, 0.5) across the outer rim | within 0.02% of π(r1² − r2²)h |
| Outline: a bar 18 x 8 x 8 on a plate, (1, 0) / (1, 1) / (0, 1) | (2·26 + π)·4, that plus 48·4, and (144 − 96)·8, to 4 digits |
| Outline: the hinge's silhouette | skin 453.162 + core 182.934 = 636.096; the footprint's area is the rays' (100.80 mm²); skin + footprint = footprint grown |

The hinge's footprint is five knuckles, each 3.6 mm along, so it is under 4 mm
across at its narrowest: a 2 mm skin of it is the whole hinge.

## Found on the way

`NSO_cropMatInvert` (the old card's, from Circle and Piece) returned the
transpose of the rotation, not its inverse. The old card only read the piece's
height and a miss test through it, which a transposed rotation leaves roughly
true, so nothing showed. The engine's `matInvert` is correct, tested through a
rotated pose, and the old card now uses it.

## For the card (ticket 2)

- `NSO_Crop.cut(piece, shape, keep, build, opts)` keeps the part **outside** as well
  and takes two gates (`pre`, `post`). It exists for the old card's Keep outside
  and goes with the card.
- `NSO_Crop.cutterSoup(shape)` is a closed soup of the cutter in P, for a preview
  (an outline with no `z1`/`z2` needs them here: it has no piece to take them from).
- `NSO_Crop.rimLoop(soupP, tri)` is the rim finder alone: `{ loop, area, loops,
  patchTris }`, for a hover that shows which loop a triangle will take.
