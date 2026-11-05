# Crop: copy what a shape holds

`nso_crop.js` is the engine, `app-crop-card.js` the card, in index.html as
`#menu-crop`. `app-crop.js` is what is left of the old slab crop (below).

```
node tools/nso_crop_engine_test.js      the copy engine: shapes, Outline, refusals, the plate (crop:engine)
node tools/nso_crop_card_drive.js       the card, with a real mouse: every shape, the handles, CROP, Undo, Escape (crop:drive)
node tools/nso_crop_shapes_drive_check.js   Cylinder, Piece and Outline copies measured against the meshes as drawn (crop:shapes)
node tools/nso_wire_crop_test.js        a copy is a real piece: export, Undo, paint, refusal, Split (wire:crop)
node tools/nso_crop_test.js             the slab crop that G-scope and Detach still use (crop:test)
```

All are in `npm test`.

## The card

Crop is one tool: **pick a shape, drag it to size, press CROP.** The card is a
**Shape** row (Box, Cylinder, Sphere, Piece, Outline), **one readout line**, **CROP**
and **Cancel**. Nothing else - no field to type a size into, no checkbox, no axis
button. `page:manifest` fails if a control finds its way back in.

Opening the card arms the piece selection (as Cut does, with no blade). Pick a
shape and it appears **centred on the selected piece at half its size**,
translucent, with grab handles. Orbit between grabs: a press that lands on no
handle and no shape is the orbit's.

| shape | on pick | handles |
|---|---|---|
| Box | centred, each side half the piece's | one on each face. It drags along the face's normal and the opposite face stays put |
| Cylinder | vertical, Ø half the narrower footprint, half the height | an end on each end (slide along the axis, the far end stays), one on the side (Ø). Pull an end round past 45° of the axis and the axis turns to follow it: the axis is whichever of x, y, z the pointer last followed on the screen |
| Sphere | Ø half the piece's smallest side | one on the surface (Ø) |
| Piece | nothing yet: click another piece to be the cutter | none (it is the other piece) |
| Outline | nothing yet: click a piece for its footprint, or **Shift-click** a triangle for its rim loop | `d1` (outer offset) and `d2` (inner offset), dragged along the surface normal at the outline's boundary, and `z1`, `z2`, the two heights |

The body itself slides the shape: across the plate by default, **straight up and
down with Shift held**. The shape is kept in the plate frame, so it stays put if the
piece is moved afterwards.

**The handles** are Rotate's rails look (`app-rotate-handles.js`): a thin rail
through each along the way it drags, a slim dart off each end of it, drawn over
everything, a fixed size on screen (38 px). No gizmo arrows. A handle is grabbed
within 14 px of it on the screen (never under 12), by its place on the screen, not
by a ray; the nearest wins.

**The readout** follows live from `NSO_Crop.planOn`: `Box 40 × 22 × 15 mm · holds
698 faces, 1.2 cm³`, `Cylinder Ø20 × 30 mm along Z · holds …`, `Sphere Ø24 mm · holds
…`, `Piece <name> · holds …`, `Outline of <name>, +1.0 / −0.8 mm, z 2.0 → 14.5 mm ·
holds …` (` rim` after the name for a rim). A refusal replaces "holds …" with the
engine's words, in the refusal colour, and CROP goes off.

**CROP** is `NSO_Crop.copy`: the copy lands where it was cut from, **selected**; one
Undo takes it off; the original is untouched. **The shape stays**, on the piece it
was picked on - the selection moving to the copy does not retarget it - so another
CROP is another copy (`crop 2`) of the same original. Selecting a different piece
puts the shape on that piece afresh. **Escape** or **Cancel** puts the shape away; so
does closing the card.

## Where every old control's job went

| old control | now |
|---|---|
| Crop X / Crop Z, the Box from / to fields, the Box tick | the dragged Box |
| Circle (Click centre, Ø) | Cylinder (drag the side for Ø, an end for the length; any axis) |
| Piece region (Pick piece, Grow) | the Piece shape (click the cutter); Grow is Outline's offsets |
| Keep inside / Keep outside | Crop always copies what the shape holds; the original is never cut. To have the original without that part, Subtract the copy from it |
| the slab crop itself (remove a slab, slide the far part back, seal the joint) | gone from the card. Crop copies; G-scope's Crop on its layer range and Detach's cap still use `NSO_cropRaw` / `NSO_cropSeal` (below) |
| Move region (Up, Across, Lift, Lock in) | removed from Crop, with `NSO_cropMoveRaw` and the code under it: **CROP, grab the copy (grab-drop), JOIN if a weld is wanted.** `crop:move` and `wire:crop-move` are retired with it; the kernel union they ran is Join's (`csg:node`, `integration`), and every copy is checked by `crop:engine` |
| Detach flange | the **Subtract** card, under Split to parts. Same ids (`btn-detach`, `detach-readout`), same behaviour |
| Reattach | the **Connect** card, its last row (under Attach's row once that lands). Same id (`btn-reattach`), same behaviour; its readout is Detach's, in the Subtract card, and the status line |
| the hidden axis selector `#edit-axis` | moved into the Cut card, where the cut code reads it |

Two things the card needed of the rest of the app, both fixed where they were:
`undoLastStep` rebuilt the plate from one piece when an `addModels` step (CROP's)
was undone with a cutter open - it empties `state.placed` - and `addModel` did the
same on an import while the Crop card was open. Both now leave the plate alone when
the cutter is Crop's.

# The copy engine (`nso_crop.js`)

Crop is one operation: **copy what a shape holds out of a piece, as a new,
sealed, solid piece on the plate.** The original is read and never written - no
cut, no cap, no repair - and comes out byte for byte as it went in. This is the
engine for it, on the Manifold kernel. The card above is the whole of its UI.

```
NSO_Crop.plan(piece, shape)  -> Promise<{ ok, faces, volumeMm3, bbox, text }>   builds nothing
NSO_Crop.run(piece, shape)   -> Promise<{ ok, tris, faces, volumeMm3, bbox, ... }>   the closed mesh
NSO_Crop.copy(model, shape)  -> Promise<{ ok, id, name, ... }>                  run + onto the plate (browser)
NSO_Crop.planOn(model, shape)  plan() for a model on the plate: the card's readout
NSO_Crop.resolve(model, shape) the pose through the mesh as drawn, and a pieceId turned into its soup
NSO_Crop.footprintPolys(shape) the outline's loops before any offset: the card's offset handles sit on them
NSO_Crop.cutterSoup(shape)     a closed soup of the cutter in P
NSO_Crop.rimLoop(soupP, tri)   the rim finder alone
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
keeps the whole grown (d1) or shrunk (d2) footprint instead of the band (the card
has no control for it; the engine's tests use it for the skin-plus-core identity).

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
sub-region and no whole-piece bake to stand down for; the copy carries no paint,
and a painted original is cropped like any other (tools/nso_wire_crop_test.js §6).

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
transpose of the rotation, not its inverse. The engine's `matInvert` is correct,
tested through a rotated pose.


# What is left of the slab crop (`app-crop.js`)

Stage 1 of the old Crop: take a slab out of a piece along one axis and close the
gap. It has no card now (the card copies). Two callers still need it, so it is kept
whole and tested (`crop:test`): **G-scope's Crop** on its layer-range slider
(`app-microscope.js`, through `NSO_cropModel`) and **Detach**, whose cap on a
flange's neck wall is `NSO_cropSeal` (`nso_detach.js`). The write-up below is as it
was, less its UI section.

## What it does

A box selects a slab of the piece along the cutter's axis. Crop removes
everything inside the box. The part past the box slides back along that axis
by the box length, so it meets the near part at the near box face. The joint
is then sealed, and the result is **one closed piece, shorter by exactly the
box length**.

That slide belongs to "crop out a middle section". It is not a repositioning.
Nothing moves sideways or turns, and the near part does not move at all. Two
sections that do not line up (a lateral offset, a twist) were Stage 2, Move, which is gone: CROP a copy, grab it, Join it.

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
- **Repositioning.** Was Stage 2, Move; removed (see "Where every old control's job went").
- **Self-intersection is inherited, not repaired.** On
  `tape_on-edge-single-B101_rounded_v8_FINAL.stl` the source already has 185
  piercing pairs, and a crop keeps them.
