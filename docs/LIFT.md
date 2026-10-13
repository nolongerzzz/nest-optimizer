# Lift - take any detail off a face, leave the face flat

Phase 1 (sections 1 - 4): `nso_lift.js` (the geometry, headless,
`window.NSO_Lift` and a Node module), `app-gscope-lift.js` (G-scope's sidebar
section "Lift", its Pick side), `tools/nso_lift_fixtures.js`,
`tools/nso_lift_test.js`, `tools/nso_lift_drive_check.js`.

Lift 2, auto-aim and Strip (section 5): `nso_lift_auto.js`
(`window.NSO_LiftAuto` and a Node module), the same `app-gscope-lift.js` (the
Strip side, and Pick on a face that bends), `tools/nso_lift_auto_fixtures.js`,
`tools/nso_lift_auto_test.js`, `tools/nso_lift_auto_drive_check.js`.

```
npm run lift:test     headless: the plate, every detail alone and all together, the ring,
                      refusals, an off-axis pose, the Picture slab, the canonical checker (771 gates)
npm run lift:drive    the real app in Chromium: real clicks in G-scope, Lift, Ctrl+Z,
                      the slider, a curved face, two Picture slabs (58 gates)
npm run lift:shots    lift:drive, keeping its screenshots in tools/lift-out/ (gitignored)
npm run lift:auto-test   Lift 2 headless: every fixture of section 5, Strip's groups,
                         Lift / Remove, refusals, the speed, where the bend bites (398 gates)
npm run lift:auto-drive  Lift 2 in the real app: Strip, the tick boxes, a click on one,
                         Lift N, Remove N, Ctrl+Z, Pick on a curved dish (40 gates)
npm run lift:auto-shots  lift:auto-drive, keeping its screenshots in tools/lift-auto-out/ (gitignored)
```

All four checks are in `npm test`.

## 1. One question, not a catalogue

Flange, Handle, Bracket, Lid and Hinge stay what they are: named rules
(`nso_flange.js`, `nso_face_features.js`), shortcuts to a known functional
feature. Lift adds no names. It asks the one question under all of them,
"what sticks out from this face, and by how much", and a detail is whatever
the answer is: a dot, a line, a letter, a ring, a bump, a texture, an ink
stroke on a relief.

| term | what it is, exactly |
|---|---|
| **base** | the flat face the user clicked. Its plane is fitted to the **coplanar patch round the click**: triangles joined edge to edge whose three corners lie within `flatTol` of the seed triangle's plane and face its way. `flatTol` = 0.001 mm + 2 ppm of the part's size (1.1 - 1.2 µm on the fixtures). The normal is the area-weighted mean, snapped exactly onto an axis when it is within 1e-12 of one; `d` is the mean over the patch's corners. |
| **island** | triangles with no corner below the plane (by more than `flatTol`) and at least one above it, joined through edges that **leave** the plane. Two islands that touch only along a line lying in the plane are two bodies once the plane is cut, so they stay two. Its **height** is the furthest any corner stands out. |
| **footprint** | the top the click is on: the face and everything standing on it, joined edge to edge without ever going below the plane. Its rim is where the part's own sides go down. |
| **liftable** | an island that stops, all round, **in** the plane, next to the face or another island - never at an open edge and never down a side of the part - and whose biggest root loop runs round it. Otherwise it is part of the body and is named as such: "it runs over the edge of the face, down the side of the part". So a part's own sharp edges, a raised rim, or a step that runs over the side, are never offered. |
| **offered** | liftable, and standing out **more than** the slider ("How far out counts"). |
| **lift** | each chosen island + a cap on its root loops, facing into the face, is its own closed piece: its flat back lies in the base plane. The plate keeps every other triangle exactly as it was, in order, and gains the same cap facing out: closed, and flat where the island stood. |

The two cases the ticket names land on the same rule. On a part with real
flat faces, an island's root loops are holes in the face. On a relief slab
there is no clean edge; the islands rise out of the paper through sloped
triangles, their root loops run through the paper's own vertices, and the
slider decides what counts. The user sees one mode and one slider either way.

**The caps are the cut engine's.** `rawFlatCapLoops` (app-cut.js) nests the
loops with `rawNestLoops` (a loop inside a loop is a hole), bridges each hole
into its outline and ear-clips. A ring's root is two loops, so its cap is an
annulus and its bore stays open - nothing is ear-clipped here. The engine
works on an axis plane; a base whose normal is not an axis is turned into a
frame where it is, the cap comes back, and every corner is mapped back to the
loop vertex it was made from, so the cap is still built of the original
vertices. Nothing is cut and no vertex is moved.

**Curved faces.** The patch round a click on a curved surface is one facet.
It is refused as curved when more than half of its outer edge bends gently
(under 20 degrees) into the next facet AND it is not at least 4x the size of
those neighbouring flat patches. The second half is what keeps a big flat top
between two fillets (the fillet strips bend 7.5 degrees, along 63 % of the
top's edge) from being refused: the top is 2160 mm^2 against strips of 31.
The words, on a 48-sided cylinder:

> Lift needs a flat face, and this one is curved: round the click it is flat
> (within 1.1 µm of one plane) over only 26.16 mm² (2 triangles), and from
> there it bends on by about 7.5° into each next facet. Pick the flat face the
> details stand on. Nothing changed.

## 2. In G-scope

On the plate (the rail button, or **Read the plate**), the sidebar's
**Lift** section, its switch on **Pick** (section 5 has Strip):

1. **Pick base face**, then click the face the details stand on. The base is
   tinted green; what is offered is drawn over the piece coloured by height
   (blue low, red high); what is liftable but lower than the slider is grey.
   What is part of the body is not drawn and is counted in words.
2. **How far out counts**: 0 to the tallest island. Default **0.42 mm =
   `NSO_Thickness.floorFor(0.4)`**, one extrusion line at a 0.4 mm nozzle
   (flagged in the PR - see 5).
3. A click on an offered island chooses it (magenta); **Shift**-click adds or
   removes. A click on a grey one says how high it stands and what to lower
   the slider to. A click anywhere else on a piece picks that face as the
   base instead (refused in words, keeping the old base, if it is curved).
4. **Lift** (it counts: "Lift 2"). The piece keeps its place and id and
   becomes the leftover plate (`NSO_sculptCommitRaw`); each island becomes a
   piece named `<piece> - lifted N`, placed on free plate nearest the piece it
   came off (`nsoFreeSpot`, app-core.js - Picture's placement, moved there so
   both share it; Picture's call is unchanged). G-scope re-reads the plate
   and keeps the base picked, so the next detail is one click away.
5. **One Undo** (Ctrl+Z, or Undo on the plate) puts everything back: the
   step is Detach's `featureSwap` (geometry swap + pieces added) with the new
   label `liftReplace`. G-scope redraws over the restored plate.

The read-out is the status line, in G-scope's sidebar and on the app's line:

> Base: the top face at z 3.00 of lift-plate, 3385.7 mm², flat within 1.2 µm.
> 2 details stand out more than 0.70 mm (0.80 - 1.50 mm). 54 lower, not
> offered (grey). Click a detail to choose it; Shift-click for several.

**Frame.** G-scope shows the plate in world coordinates; Lift runs on the
piece's raw soup (`m.rawTris`), which is what the piece is. The two are the
same triangles in the same order, and the clicked triangle is checked to be
the same shape in both before anything is read off it (a piece scaled on the
plate is refused). So a lifted piece is in the piece's raw frame: on a part
lying as it was made (base normal raw +Z) its flat back is on the bed.

**Paint scope: WHOLE-PIECE.** Lift replaces the piece's soup, so a painted
face could lose triangles or gain new ones; `nsoMaskCount(m) > 0` stands it
down by count ("Lift stood down - N painted face(s)..."). In the HANDOFF
roster and `nso_paint_scope_test.js`.

## 3. Checked on

### The ticket's plate (`tools/nso_lift_fixtures.js`, generated in the test)

60 x 60 x 3, top at z = 3: five dots (16-gons, 2 mm across, 0.6 high) in a
dice-five grid; a raised line 30 x 1 x 0.6; a ring 8 mm outer, 6 mm bore,
0.8 high; a spherical-cap bump 8 mm across, 1.5 high; 48 small bumps (1.2 mm
square frustums, 0.5 high). Every detail has real vertical walls and is fused
into the top through a hole of its own footprint. 1822 triangles.

| | measured |
|---|---|
| the base | n (0, 0, 1), d 3, exactly; 3385.7 mm² of face, 56 islands, all liftable; 14 - 19 ms |
| each island | its height and triangle count as the generator built them (dots 0.6 / 46, line 0.6 / 10, ring 0.8 / 192 on two loops, cap 1.5 / 416, bumps 0.5 / 10) |
| the slider | at 0.42 all 56 offered; at 0.6 a 0.6 mm dot is not (more than, not as much as); at 0.7 only the ring and the cap |
| each of the 56 alone | piece closed and manifold, no degenerate or duplicate faces; its back = its cap, every triangle in z = 3 facing down, covering exactly the footprint; the piece is the island's own triangles bit for bit plus its back; its volume is the generator's. Plate closed; every other triangle the source's, in order, bit for bit; everything new lies in z = 3 facing up and fills exactly the piece's back; plate + piece = source (residuals 1e-12 mm³) |
| all 56 together | 10 ms. Plate 10800.000 + pieces 103.734 = 10903.734 mm³; a fresh click finds one flat face of 3600 mm² with nothing on it; nothing above z = 3 |
| the ring | chi 0 (genus 1); a line down its centre meets no triangle; its back is the annulus, 21.850 mm² |
| turned 30° about Z then 20° about X | the same 56 islands, normal (0, -0.3420, 0.9397) to 1e-6, ring and cap lift closed with their own volumes through the turned frame |
| canonical checker | `mesh_validate.py` with self-intersection: the dot, line, ring, cap, a bump, the plate after the dot, after the ring, after all 56 - each PASS, 0 piercing, 0 coplanar (no coincident faces) |

### Refusals and what is not refused

| case | result |
|---|---|
| a 48-sided cylinder's side | refused as curved, in the words above; the soup is untouched |
| the same cylinder's top | a flat face, nothing on it |
| a 60 x 40 block with filleted long edges, its top | **not** refused (see 1) |
| a stepped block, the low top | the high half is one island, refused: "it runs over the edge of the face, down the side of the part - it is part of the body, not a detail on the face" |
| the plate's bottom face | flat; nothing stands proud of it |
| Lift with nothing chosen | "nothing is chosen - click a detail first" |

### The Picture slab

`camera.png` (the photo `relief:test` uses), Levels 2, 40 mm at 0.4 mm/sample,
41,612 triangles: the paper is exactly z = 2; analyse takes 120 - 170 ms. 45
islands stand proud of it. **5 run down the slab's sides and are part of the
body** - the figure, the tripod and the ground reach the slab's edge, so in
this photo the big shapes are not liftable (the scope rule, by design); 40 are
liftable, and at 0.42 mm the slider offers 2 (0.69 and 1.85 mm) - the rest
are anti-aliased specks 0.06 - 0.38 mm high. Each lifts alone with every gate
above; together, 4270.472 + 1.343 = 4271.815 mm³, the slab PASSes the
canonical checker.

In the real app (`lift:drive`), through Gen+ -> Picture and G-scope's Export
to plate: the same photo, and the simulated scan (`line-drawing-scan.jpg`,
Levels 2, 60 mm at 0.4, 69,916 triangles) where the drawing is inside the
paper: 11 details offered (0.94 - 1.93 mm); the house, tree and ground line
are one island because they touch; the four biggest lift as four closed
pieces, 5406.276 + 126.324 = 5532.600 mm³, and one Ctrl+Z puts the slab back
bit for bit.

### In the real app (`lift:drive`, 58 gates)

Pick base face and every choice are real clicks on G-scope's canvas at the
screen point of a triangle G-scope drew. Lift on ring + cap: one undo step,
the piece keeps its id, 1214 of 1822 triangles kept bit for bit, 94 new ones
flat in z = 3, two closed pieces (the ring chi 0) on the bed and clear of
everything; G-scope re-reads and still has the base (54 left). Ctrl+Z: the
piece bit for bit, both pieces gone, the undo stack as before, G-scope redrawn
(56 again). The slider, a click on a grey dot, all 56 at once and one Ctrl+Z
for all of it, a curved face refused with the plate and undo stack untouched.

## 4. Scope limits, said in the status line

- **Flat bases only.** A curved face, or one not flat within the stated
  tolerance, is refused in words and nothing changes.
- **Features that touch form one island**; nothing splits them. (Touching
  only along a line in the base plane is not touching above it: two islands.)
- **A stepped face:** the picked face is the base; anything higher on the
  same top is a detail if it stands inside the footprint.
- **The search stays inside the picked face's footprint**: anything that
  runs over the edge of the face is part of the body and is said to be.
- **Plate pieces only.** In a document that is not the plate (a file, or
  Picture's slab before it is sent to the plate) Lift says to send it to the
  plate first.
- **A relief whose paper is not exactly flat** (Smooth levels, a noisy scan)
  has no clean base patch; phase 1 does not fit a base through noise.

Not here, on purpose (later phases): curved bases, grouping and the
descriptive list, keeping a texture to stamp elsewhere. The optional
drag-box correction was not built.

Section 5 (Lift 2) takes the first and last of these for a base that bends
gently (each detail cut at its own flat plane, within 0.15 mm), and adds the
grouping (Strip). Neck splitting, the curved-base repair and the texture stamp
are still later tickets.

## 5. Lift 2 - auto-aim and Strip

Phase 1 finds details from the clicked face's coplanar patch, so it needs a
flat base. Lift 2 finds them from a top-down height map of the piece, so a
base that bends gently works too. **The map decides WHERE a detail is; the
real mesh decides WHAT comes off.** Nothing is photographed or uploaded: the
map is the mesh, rasterized in the app. Phase 1 is unchanged - `nso_lift.js`
only gained an `internals` export (its `planeFrame`, `boundaryLoops` and
`capFor`, which Lift 2 calls as they are).

### The map, the base, the islands (`nso_lift_auto.js`)

| step | exactly |
|---|---|
| **view** | the area-weighted mean normal of the triangles joined to the click within 10 mm and within 60° of it (walls left out); put on an axis when within 0.5° of one |
| **map** | every triangle facing the view rasterized into a height grid, 0.25 mm per cell: each cell keeps the highest surface and the triangle that is on top there. Past 4 million cells it is made coarser and said so ("the piece is 600 x 500 mm across, and at 0.25 mm per cell its height map would be 4.8 million cells, over the 4 million it keeps - so it is read at 0.28 mm per cell instead"). A cell whose top triangle is more than 70° off the view (a wall seen nearly edge-on) is kept but marked steep |
| **base** | `NSO_LiftAuto.estimateBase(map)` - ONE replaceable function. Today a rolling ball: a morphological opening with a spherical element, radius 0.2 of the piece's shorter footprint side clamped to 4 - 15 mm, no slider. Empty and steep cells hold nothing up; ball centres may sit off the piece, so a surface rising toward its edge is followed. The ball is rolled on cells grouped so its radius is 12 of them (each group read as its median), then read back bilinearly, never above the surface |
| **detail** | a cell more than 0.32 mm above the base: more than a print's layer step (0.2 - 0.3 mm), so a stepped print never reads as stepped details. The slider then offers an island standing out MORE than it, as Phase 1 does, so moving it filters and never reads the map again |
| **island** | 8-connected detail cells next to the face (the base cells 4-joined to the clicked cell); enclosed gaps of one or two cells closed; bigger enclosed gaps kept as the island's holes (a ring's bore, the inside of a wide plateau the ball rose into) |
| **its own plane** | least squares over the island's base samples: face cells 0.75 - 2.25 mm out, clear of anything standing out, where the surface and the base estimate agree to 0.04 mm (else 0.1 mm, else the threshold; and closer in, when details are packed). If they are more than **0.15 mm** off that plane the island is refused - "the surface under it bends too much for a flat cut (it is 1.17 mm off one flat plane across its footprint; a flat cut allows 0.15 mm)" - and the rest go on. Once the real triangles are known the plane is refitted to the island's own root loop (where the cut is), refused the same way past 0.15 mm |
| **the real triangles** | seeds: the top triangles of the island's cells that stand above its plane by more than (bend + 0.02 mm); grown edge to edge through triangles that stand above it and never below it, never across an edge lying in the plane, within the measured ring. A body that runs on past the ring is measured further and grown again (up to 12 times); islands whose triangles run into each other are merged; bodies that only touch in the map split into separate islands |
| **can't lift** | Phase 1's rules, word for word where they are the same: an open edge; "it runs off the edge of the face, down the side of the part"; round the face rather than on it; loops that don't close; plus "the surface under it bends too much for a flat cut", "too little of the face round it to measure" and "it runs on past the part of the face measured round it" |
| **lift / remove** | Phase 1's cap (`capFor` -> `rawFlatCapLoops`) at the island's plane, built of its root loop's own vertices: the back is on the plane to within the measured root bend. Where the root is not exactly flat the cap's inside edges are re-paired toward Delaunay - same corners, same outline - so no sliver climbs over the walls; an island corner that comes down to the plane inside its own outline becomes a cap corner when that keeps the piece closed. The plate keeps every other triangle in order and gains the same cap; Remove is the same cut with no pieces |

### Strip's groups - geometry only

On the island's footprint (the cells whose top triangle is the island's):
width = twice the deepest inside distance (exact Euclidean distance
transform), length = area / width.

| group | rule |
|---|---|
| Small dots | compact and small: not a line, and footprint at most 16 mm² |
| Lines & squiggles | length at least 4 x width, and width at most 3 mm (a ring is a closed line) |
| Large shapes | every other liftable island |
| Can't lift | every island that can't be lifted, its reason in words under the row |

### In G-scope

The section is **Lift**, with a two-way switch **Pick | Strip**.

- **Pick** is Phase 1 on a flat face, unchanged. On a face Phase 1 refuses as
  curved, the map reads it when it finds something standing on it ("This face
  bends, so it is read from a height map instead of as one flat face." then the
  same read-out, each detail "lifted at its own flat cut"); when the map finds
  nothing, Phase 1's refusal stands with "Read as a height map instead, nothing
  stands out of it more than 0.32 mm either. Nothing changed." (`lift:drive`'s
  cylinder).
- **Strip**: Pick base face, then a click on the face - everything the map
  finds there, coloured by group on the model (ticked solid, unticked faint,
  below the slider grey, can't-lift dark red), and per group a tick box and a
  count ("1 of 3" when a click has overridden the box). All liftable details
  start ticked. Untick a group to keep it on the plate; a click on one island
  ticks or unticks it alone. **Lift N**: each ticked island its own closed
  piece on free plate (Phase 1's placement), the plate left flat. **Remove N**:
  the ticked details thrown away, the plate left flat, no pieces. One Undo
  (Ctrl+Z) puts everything back for either ('featureSwap', labels "Undo: Lift
  reverted" / "Undo: Remove reverted"). Switching Pick <-> Strip keeps the base
  and reads it again with that side's finder. Paint scope: WHOLE-PIECE for
  both (`Remove stood down - N painted face(s) ...`).

### Checked on (`lift:auto-test`, all fixtures generated in the test)

| fixture | found | result |
|---|---|---|
| flat plate: 5 dots, a line, an S, a ring, two dots fused into one body, a mushroom (undercut) | 10, all liftable - **exactly Phase 1's islands, triangle for triangle**; every plane z = 3 exactly | groups 6 / 3 / 1 / 0; each lifts alone with every Phase 1 gate (closed, back in its plane facing in, own triangles bit for bit, generator's volume, plate bit for bit + cap); the mushroom keeps its underside; the ring chi 0; Strip with lines unticked lifts exactly the 7 ticked and a fresh read finds the 3 lines; Remove all leaves the bare 10800 mm³ slab, flat (Phase 1 reads one 3600 mm² face) |
| Phase 1's plate (56 details, 48 packed bumps 2.5 mm apart) | the same 56, triangle for triangle | all 56 lift; the bare slab, closed |
| a bowl, radius of curvature 150 mm: 6 dots, a 40 mm squiggle | 7 | Phase 1 refuses it as curved; the 6 dots lift at their own planes (tilted up to 11°), backs within 0.03 mm; the squiggle is refused: "bends too much for a flat cut (1.17 mm ...)"; Remove the dots and a fresh read finds only the squiggle |
| the Picture slab (camera.png, as Phase 1) | 8 | Phase 1's two offered details (0.69, 1.85 mm) offered here too, plus three of 0.43 - 0.49 mm that stand on low relief the ball counts as base; 2 run off the slab's side ("runs off the edge of the face, down the side of the part"); the large figure is refused as bending 0.17 mm |
| paper with +-0.08 mm noise, three blobs and a bar | 4, all lift | no noise reads as a detail; each back follows the paper within 0.08 - 0.09 mm. At +-0.16 mm noise: still the 4 and all lift |
| 0.2 mm layer steps, 5 mm terraces | the 6 details, no step | Phase 1 on one terrace sees the higher terraces as body and nothing liftable; the map: all 6 lift - dots on a terrace with a flat back (root 0.000), the dot across a step and the bar across two steps with their backs 0.10 mm off flat |
| three leaves touching at a stem, one apart | 2 | one island for the three (large), one for the lone leaf; both lift. The cluster comes down to the paper at one corner inside its outline, so its back touches it there (4 contacts by the canonical checker, each that corner - gated as exactly that) |
| a 600 x 500 mm box | - | the map coarsened to 0.28 mm per cell and said so |

Refusals in words: a click on a detail ("that click is on something standing
0.60 mm out of the face, not on the face itself - click the face the details
stand on"), a click on no triangle, Lift / Remove with nothing chosen.

**Where the 0.15 mm bend tolerance bites** - straight bars 1.2 mm wide on
bowls (the ring of base samples reaches about 2 mm past the bar):

| bowl radius | lifts | refused from |
|---|---|---|
| 300 mm | bars to 16 mm | 20 mm (0.17) |
| 150 mm | bars to 10 mm (0.12) | 12 mm (0.16) |
| 60 mm | bars to 4 mm (0.13) | 6 mm (0.18) |
| 30 mm | none | 2 mm (0.17) |

Roughly, a footprint L mm long on a bend of radius R is refused once
(L + 4)² / 8R passes 0.15. A long squiggle on a tightly curved lip refuses,
as the ticket accepts; the curved-base repair is a later ticket.

**Speed.** The dish at 0.17 mm per sample, 501,260 triangles: the map builds
in 41 - 105 ms; the whole read 0.9 - 1.5 s (the exact weld 0.6 - 1.1 s of it,
the rolling ball 45 - 90 ms, islands and triangles 140 - 180 ms).

**4b, data only - where a watershed would split.** Each island over 16 mm²
carries `necks`: the smoothed distance transform flooded from the top, two
basins meeting at a saddle below 0.7 of the smaller one's peak. The three
leaves: 3 parts, necks 3.61 and 3.35 mm wide at (17.38, 21.13) and (17.38,
18.88). Not shown in the panel, not cut with.

### In the real app (`lift:auto-drive`, 40 gates)

Real clicks on G-scope's canvas and the sidebar: Strip on the flat plate (10
found, 6 / 3 / 1 / 0, Lift 10 / Remove 10); untick lines -> Lift 7; a click on
the ring -> Lift 8, "1 of 3", again -> Lift 7; Lift 7: seven closed pieces on
free plate, the 3 lines stay, one undo step, Ctrl+Z bit for bit; Remove 10:
no pieces, the bare slab, Ctrl+Z bit for bit; back to Pick: Phase 1's read-out;
the dish in Pick (read from the map, a dot lifts, Ctrl+Z bit for bit) and in
Strip (6 dots, the can't-lift row says why, Lift 6, Ctrl+Z bit for bit).
