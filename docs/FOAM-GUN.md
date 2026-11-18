# The GUN - point into a gap, spray, it fills from plate to face

`nso_foam_gun.js` (the engine), `app-foam.js` (the GUN section), `index.html`
(`#btn-foam-gun`, `#foam-gun-panel`) in the **Fill & fix** card.
Tests: `tools/nso_foam_gun_test.js` (in `npm run foam:test`, 51 gates) and
`tools/nso_foam_drive_check.js` section 16 (in `npm run foam:drive`).

## 1. What it is

A spray-foam gun. No box, no field. Arm GUN, aim into a gap - a slot, a crack,
a notch, the space left between two welded parts - at its wall, and hold the
mouse. That gap fills, rising from the plate, while you hold; letting go sets
it as one Undo. The gun stays armed for the next gap.

| Foam tool | what it fills | how it is aimed |
|---|---|---|
| **FOAM, Box** (default) | every bit of buried space inside a box | Crop's Box, by its handles (docs/FOAM.md §10, §11) |
| **FOAM, Hollows** | one sealed hollow, to a level | the hollow list / a click in the ghost (docs/FOAM.md §1-9) |
| **GUN** | the one gap the click is in, plate to face | the click itself |
| **Patch** | an open hole in the surface | hover a hole's rim (docs/PATCH.md) |

FOAM and GUN share nothing but the orange: the GUN's engine is its own file, and
`nso_foam.js` (foamBox, the hollow Foam) is unchanged by it.

## 2. The model

- **up** is the plate's vertical as the piece lies (the same `upRaw` as Foam).
- **the seed**: the click's ray meets the gap's wall; 0.02 mm back along the ray,
  in the air it came through, is the seed. A click on the top face puts the seed
  over the piece: refused, "aim into a gap, at its wall".
- **a gap at a height**: the piece is sliced there (the kernel's `slice`). The
  section's outline is **closed** by a radius r (grown by r, shrunk by r) and its
  holes filled; what that holds that is not material is the gaps. r = 0 is a gap
  closed all round (a slot). A gap open to the side - a notch - needs the r its
  mouth needs: the smallest of 0, 0.005, 0.01, 0.02, 0.035, 0.05, 0.1, 0.2, 0.4 ...
  6.4 mm (and no more than a quarter of the piece's smaller width) that puts the
  seed in a gap at least 8 r² in area. Closing also rounds every inside corner by
  about 0.21 r², and a corner is not a gap - a wide shallow groove is refused, not
  filled. Past the ladder the seed is in open air: refused, in words.
- **out to the outside**: the smallest r shuts a mouth at its narrowest; a mouth
  that flares leaves the rest of it outside that (a weld's hairline crack does; a
  notch's arms run on past their narrowest). Wider closings, each up to 2.5 x the
  last, take the gap out to where its mouth meets the outside while the gap they
  give still holds the first: up to 0.1 mm (a hairline's flare) so long as it is
  still a pocket, and past that up to 4 x the r it was found at so long as each step
  grows the gap by no more than 25% - a mouth closing flush grows gently (the
  welded notch's outer channel: 1.74, 1.85, 1.91, 1.96 mm² from r 0.3 to 1.2), a
  closing that has reached open air jumps. The readout names the mouth at its
  narrowest, not the closing that took it out.
- **needles**: a triangle the kernel leaves with three corners in a line (no
  area) goes, and the triangle across its long edge is split at its middle corner.
- **reach**: a hairline slit is narrower than the seed's 0.02 mm step back off the
  wall, and seen from above a click lands on the top face beside it. A gap within
  `reach` of the seed counts as aimed at (the nearest wins), and a click on the top
  or bottom face is taken just inside it. The page passes 6 pixels' worth of mm at
  the hit's depth (0.02 - 0.5 mm): a gap is aimed at when the cursor is within 6 px.
- **slabs**: the piece's height is cut at every height a corner of it lies on -
  heights within 1e-4 mm of each other are one (float noise on a flat face is one
  level) - and no slab is taller than 0.5 mm. A slab's gap is read at its middle.
  Exact for walls that stand straight up; a slanted wall is followed in 0.5 mm
  steps.
- **the pocket**: the seed's gap in its slab, then slab by slab down and up, the
  next slab's gaps that overlap it. It ends where a slab has none (a floor or a
  ceiling, in material) or at the piece's end - **the plate** below, **the face**
  above. A gap whose bottom is within 0.5 mm of the plate over air (a part standing
  a hair proud of the plate) drops to the plate: foam stands on the plate.
- **the foam**: slabs whose pocket is the same shape go up as one prism (a gap with
  straight walls is one extrusion, plate to face). Each is grown 0.03 mm into the
  walls - never past the closed outline - and at the plate and the face it
  overshoots by 0.05 mm, then the whole is trimmed back to the piece's own end
  heights. A flat face spread over float noise then leaves no hair-thin tunnel
  along the foam's edge (a flush union on fixtures/welded_gaps.stl left 15).
- **the union** is the boolean kernel's (manifold-3d, vendored), then corners
  closer than 1e-4 mm fold together (`simplify`), and a triangle whose corners
  land on one float32 point is dropped.
- **amount** 0..100: the foam is cut flat at that fraction of the pocket's height.

## 3. What it promises, and what it does not

It is the forgiving tool. It works on what welds and unions leave - float noise on
flat faces, needle triangles, a wall pinched to nothing - which foamBox, being
exact, refuses.

- **Promised**: the result is one closed, 2-manifold solid (by exact corners, the
  census Foam uses); it gained exactly the volume it reports; nothing is added past
  the piece's own outline except across a closed mouth.
- **Not promised**: faces the foam did not reach coming back bit for bit. The kernel
  lays the mesh again where foam and piece meet, and `simplify` re-lays flat
  regions whose corners are within 1e-4 mm of where they were (on
  welded_gaps.stl the triangle count drops from 34,964 to about 10,000; the shape
  does not change by more than that).
- **Not repaired**: what was wrong with the piece away from the gap. welded_gaps.stl
  fails `tools/mesh_validate.py --gate` before (1,068 piercing pairs at its 1e-4 mm
  weld, a bottom face folded over itself) and still does after (about 50, all on
  that bottom face, which the gun does not touch).

## 4. Controls

The cursor is a little foam gun (nozzle tip at the hotspot), and it says what a press
would do before you press:

| cursor | means |
|---|---|
| plain gun | off the piece - a press there orbits |
| grey dots | reading the piece (on arming, and after each set) |
| **green tick** | over a gap the gun can fill: **hold now** |
| red bar | over the piece but not in a gap (the top face, a wide groove) - nothing to fill |
| orange foam | spraying |

Straight down a through-gap the ray meets nothing; the gun then aims at the middle of the
ray's run through the piece's box, so a slot seen from above shows the tick too. A press
there is the gun's only when the cursor already shows the tick; otherwise it orbits.

| step | what happens |
|---|---|
| **GUN** | armed; the piece is read at once (the busy cursor), and the ghost's and the foam's shaders are built then, so the first press does not wait for them. FOAM (either mode) steps aside. |
| **hover** | each move asks the engine `probe` - only the slab under the cursor, a few ms on a read piece. Rest on a gap for 120 ms and its foam is built ahead. |
| **press** on a ready gap | the ghost, the spraying cursor and the foam at once (built ahead); elsewhere the gap is read and built after two frames, so the ghost shows first |
| **hold** | the foam rises from the pocket's bottom, 0 to 100 in 3 s (`GUN_SECONDS`); the readout "+412 mm³ - holding" |
| **release** | the amount reached is set, one Undo ("Undo: Foam reverted"); the readout "+1,044 mm³ set - the gap is filled" (or "- 40% of the gap"), and the foam that went in glows over the piece for 1.4 s, fading, so it is plain what changed |
| **tap** | let go before any foam has visibly risen (a 250 ms hold's worth), or before the gap was read: **nothing is set**, and the readout says to hold |
| **again** | the next press takes the piece as it now is |
| **Escape / Cancel / GUN** | put the gun away; sprays already set stay |

Times (fixtures/welded_gaps.stl, in Node): the piece read once, about 0.4 s; a probe under 5 ms
after the first; a spray 0.1 - 0.8 s. Slabs are cut between corner heights and subdivided only
where a slanted face spans them, and runs of slabs with one outline go up as one prism (the long
slot: 1 prism, not 58).

## 5. Results (`tools/nso_foam_gun_test.js`)

| gate | result |
|---|---|
| a through-slot in a block | 800 mm³ exactly, plate to face, genus 1 -> 0 |
| a slot open at the top only / at the plate only | 240 mm³ each, floor to face / plate to ceiling |
| a 20 mm-wide groove in the outside wall | refused: not a gap |
| a chamber behind a 0.4 mm mouth | 863 mm³ of 864 (the mouth's closing arc), the block whole again |
| amount 50 | 400 mm³, level half way |
| float noise (2e-5 mm) on the faces | 799.999 mm³, plate to face |
| fixtures/welded_gaps.stl, four shots | 1,044 + 140 + 1.2 + 151 mm³, each closed, genus 2 -> 0, 0.1-0.8 s each |
| ...then its hairline slit to the outside, clicked on the top face beside it | 0.62 mm³, out to its flared mouth; a click 0.4 mm away is refused |
| ...then the notch's outer channel (its mouth shut at its narrowest by the notch shot) | 56 mm³: the arm's edge runs on into the S-curve; the same shot again finds no gap |
