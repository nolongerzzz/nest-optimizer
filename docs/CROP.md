# Crop, stage 1: remove a slab and rejoin

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
- **Stage 2: repositioning and alignment.** Nothing here moves a part
  sideways.
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
