# Crop: remove a slab and rejoin (stage 1), move a region (stage 2)

`app-crop.js`, loaded right after `app-mirror.js`. It uses Cut's raw clip
(`app-cut.js`) and the sculpt commit (`app-sculpt.js`), and does not copy
either of them.

```
node tools/nso_crop_test.js        headless: canonical checker on every result, refusals, box -> faces
node tools/nso_wire_crop_test.js   the real app: the Cut-menu row, the box drag, commit, export, undo
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

Cut menu, under Split. **From** and **to** are millimetres from the piece's
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

Cut menu, under Crop:

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
