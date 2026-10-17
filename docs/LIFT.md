# Lift - take any detail off a face, leave the face as it was round it

> **G-scope's Features readout is gone** (`app-gscope-lift.js`, `#ms-lift-row`; G-scope's
> SELECT ticket, `docs/GSCOPE-SELECT.md`). Lift is worked on the plate; the sections
> below that describe the read-only G-scope row are history.

**Where Lift is worked (section 7):** on the plate, from the Subtract card's
**Lift** verb (`app-lift-plate.js`). G-scope's row is **Features**, read-only:
it shows what Lift would find and nothing else. Sections 2 and 5's "In
G-scope" describe the G-scope controls Lift had before; the engine they
describe (`nso_lift.js`, `nso_lift_auto.js`, `nso_lift_curved.js`) is
unchanged, only where and how it is driven.

Phase 1 (sections 1 - 4): `nso_lift.js` (the geometry, headless,
`window.NSO_Lift` and a Node module), `app-gscope-lift.js` (G-scope's sidebar
section "Lift", its Pick side), `tools/nso_lift_fixtures.js`,
`tools/nso_lift_test.js`, `tools/nso_lift_drive_check.js`.

Lift 2, auto-aim and Strip (section 5): `nso_lift_auto.js`
(`window.NSO_LiftAuto` and a Node module), the same `app-gscope-lift.js` (the
Strip side, and Pick on a face that bends), `tools/nso_lift_auto_fixtures.js`,
`tools/nso_lift_auto_test.js`, `tools/nso_lift_auto_drive_check.js`.

Lift 3, curved bases (section 6): `nso_lift_curved.js` (`window.NSO_LiftCurved`
and a Node module: the repair), `nso_lift_auto.js`'s `{ curved: true }` read,
the same `app-gscope-lift.js`, `tools/nso_lift_curved_fixtures.js`,
`tools/nso_lift_curved_test.js`, `tools/nso_lift_curved_drive_check.js`.

```
npm run lift:plate    Lift on the plate in the real app at 1280 x 800: the Barocke plate - arm,
                      the count, hover, a click, Shift-click, Strip, Move / Join, G-scope's
                      Features row, refusals (section 7)
npm run lift:plate-shots  lift:plate, keeping its screenshots in tools/lift-plate-out/ (gitignored)
npm run lift:assembly   Lift keeps an assembly together in the real app at 1280 x 800: the hinge
                        and a plate of posts with collars - the card's words, hover, Pick,
                        Shift-click, Strip, the export, a lone floating shell refused (section 8)
npm run lift:assembly-shots  lift:assembly, keeping its screenshots in tools/lift-assembly-out/ (gitignored)
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
npm run lift:curved-test   Lift 3 headless: the spiky ball, a domed plate, a cylinder, Lift 2's
                           fixtures read curved, the canonical checker (483 gates)
npm run lift:curved-drive  Lift 3 in the real app: Pick on the ball, Strip on the dome, Lift,
                           Remove, Ctrl+Z (23 gates)
npm run lift:curved-shots  lift:curved-drive, keeping its screenshots in tools/lift-curved-out/ (gitignored)
```

All seven checks are in `npm test`. The three drives (`lift:drive`,
`lift:auto-drive`, `lift:curved-drive`) work Lift on the plate since
section 7.

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
grouping (Strip). Section 6 (Lift 3) takes the curved-base repair. Neck
splitting and the texture stamp are still later tickets.

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
as the ticket accepts; the curved-base repair is a later ticket (section 6:
in the app every one of these bars now lifts).

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

## 6. Lift 3 - lift off a curved base, repair to match

Lift 2 refuses a detail whose base bends more than 0.15 mm across its
footprint, so the bumps on a curved surface (a spiky ball) are all refused.
Lift 3 removes that limit. **Detection is unchanged** - the same map, the
same rolling ball, the same islands. What changes is the lift and the repair:
each detail is cut along the surface it stands on, and the plate is made good
there with the surrounding exposed surface carried across, welded to the real
neighbour triangles at the rim.

It is one option on Lift 2's read: `NSO_LiftAuto.analyse(soup, tri, { curved:
true })`. Without it nothing changes (Lift 2's `lift:auto-test`, 398 gates,
passes untouched). G-scope always asks for it (Pick on a face Phase 1 calls
curved, and Strip). On a face that is flat it changes nothing either: an
island whose surround is one plane to within the flat tolerance (1.1 µm) is
Lift 2's, flat cap and all - on the flat plate, Phase 1's plate and the
leaves, `curved: true` gives exactly Lift 2's islands, plate and pieces, bit
for bit.

### The base under a curved island

| step | exactly |
|---|---|
| **samples** | the band of the face round the footprint Lift 2 already measures (0.75 - 2.25 mm out, clear of anything standing out) - all of it, not only its cleanest cells (on rough paper those are its lower envelope) |
| **the base carried across** | quadratics `h = a u² + b uv + c v² + d u + e v + f` fitted by least squares to those samples, one at each node of a lattice 1.5 mm apart, each sample weighted `exp(-r² / 2σ²)` from the node, σ = 3 mm; read anywhere as the nodes' quadratics blended bilinearly. Where no quadratic fits the samples about as well as the rolling ball does (rms more than twice the ball's + 0.02 mm), the rolling-ball base itself, and the lift says so |
| **what comes off** | Lift 2's growth, with "above the base" meaning above that surface along the view, not above a plane: the band that counts as on the base is three times the surround's rms about it (plus 0.02 mm, under 0.75 x the detection threshold) |
| **too slantwise** | an island whose surround leans more than **35°** off the view is refused - "it is seen too slantwise from where the face was clicked to measure the surface round it - click the face nearer it (its surround leans 62° off the view; 35° is the most it reads)" - and shown, never cut |

**Why not the rolling ball's own surface under the detail.** The ticket
says to cap against the rolling-ball base. Measured, that leaves a visible
patch: the ball rolls under the surface from below, so under a bump on a
convex surface its top is the ball's own curve (8.7 mm radius on the 40 mm
ball), not the surface's (20 mm). A fill that relaxes to it sat **0.25 -
0.35 mm off the sphere** under the 6 mm domes, 0.08 - 0.11 under the spikes;
on the cylinder the ball fallback put a 0.064 mm ghost of the ridge back,
creased 7° at the rim. So the base the fill relaxes to is the rolling ball's
base where the ball touches the surface - the exposed surround - fitted and
carried across, not the ball's curve inside the footprint. With it the same
fills sit within 0.001 - 0.034 mm of the true surface (below).

### The fill (`nso_lift_curved.js`)

| step | exactly |
|---|---|
| **rim** | the root loops' own vertices, unmoved: the fill shares them with the real neighbour triangles - the same position, bit for bit, no step |
| **inside** | the loops ear-clipped by the cut engine (`capFor` -> `rawFlatCapLoops`), then a lattice of points inside at about one root edge's spacing (0.12 - 0.8 mm), none closer than 0.45 of it to the rim, each inserted and the triangles kept Delaunay (Lawson flips; the root edges are never flipped) |
| **height** | `w = base + d`. `d` is held at the rim corners and at the far corners of the real triangles round them (the neighbours as they are); inside, `d` minimises `Σ (cotangent Laplacian of d)² / area + 4 / relax⁴ · Σ area · d²` over the points inside AND the rim corners, relax = 1.5 mm (the width of the ring the base is measured on). A rim corner's Laplacian reaches across the weld into its real neighbours, so keeping it small carries their slope into the fill there, triangle by triangle (a C1 join; a harmonic fill would match only the height); the second term lets `d` die away into the base inside. So where the base and the real neighbours disagree, the boundary follows the neighbours and the middle relaxes to the base. Nothing else: no smoothing, no texture made up |
| **pieces** | the plate gains the fill facing out; the lifted piece gains the same fill turned over as its back, corner for corner. Plate + piece = the source, exactly. The piece's back follows the curve it came off, so it no longer sits flat: its lowest point is on the bed |

### The honest ceiling - said, never refused

Each lift says in words (`r.notes`, appended to the read-out as "Note: ...")
where the fill matches the surroundings at the rim but has nothing measured
to follow inside:

- **bigger than its surround** (footprint area more than the clear surface
  measured round it): "detail 5 covers 83.1 mm², more than the 78.8 mm² of
  clear surface measured round it: across its middle the surface carried
  under it is the base fitted to that surround - it matches what is round it,
  it cannot show what was under the detail"
- **rough neighbours** (rms about the fitted base over 0.02 mm): "the surface
  round detail 1 is rough (0.030 mm rms about the smooth surface fitted to
  it): the fill meets it at the rim and runs smooth across - the roughness is
  not made up under it"
- **no smooth fit** (the rolling-ball fallback above).

### Checked on (`lift:curved-test`, 483 gates, every fixture generated in the test)

Every lift is gated from the output soups alone: piece and plate closed and
manifold; the piece the island's own triangles bit for bit plus its back; the
back the plate's fill turned over; every other plate triangle the source's,
in order; plate + piece = source; **every root edge welded** (shared by the
fill and the real neighbour, the same corners bit for bit); **no crease** -
the weld angles (between the fill triangle's and the neighbour's normals)
have median and 95th percentile within 1° of the 95th percentile of the
angles the surround makes with itself, and their worst within 1° of its
worst (a flat cap on these bumps meets the sphere at 5 - 9° all round); **on
the true surface** (every fill corner within 0.05 mm); **not a flat cap**
(the fill stands off its best plane at least half as far as the true surface
does over the same points); **the curvature tracks the base** (the fill's
fitted Hessian within 15% of the true surface's).

| fixture | Lift 2 | Lift 3 |
|---|---|---|
| **the spiky ball** - a 40 mm icosphere, 81,920 triangles, 6 spikes (cones 2.4 mm high) and 8 domes (paraboloids 1.2 high, 6 across) pushed out of it | every bump refused ("bends") | each bump, clicked beside, lifts with every gate. Spikes: welds 0.95 - 1.11° at worst against the ball's own 0.71 - 1.22°; the fill on the sphere within 0.001 - 0.003 mm. Domes: welds 2.07 - 4.86° at worst against the surface's own 3.92 - 5.47° there (the rim corners left 0.02 - 0.03 mm up, under the band); within 0.023 - 0.034 mm. 0.5 - 0.8 s per bump, read and lift |
| the ball, all 14 one after another | - | closed and bare: every corner within 0.034 mm of r = 20; 33507.548 mm³ against the bare icosphere's 33505.790; a fresh read from four sides finds nothing |
| the ball, one click | - | the bump beside the click lifts; the five round the curve are refused as too slantwise, in words, and Lift on one says so |
| **a domed plate** (R 80) - 8 dots, a 36 mm squiggle, a 10 mm plaque | the squiggle refused (1.74 mm) | all ten lift, together and alone: welds 0.21 - 0.23° against the dome's own 0.20 - 0.21°, the fill on the dome within 0.000 - 0.001 mm; the plaque's note in words; Remove all and a fresh read finds nothing |
| **a cylinder** (30 mm across) - 3 spikes, 4 domes, a ridge 16 mm round it (61° of arc) | refused | all 8 lift; the ridge's welds 1.53° at worst against the cylinder's own 1.53°, within 0.001 mm |
| Lift 2's flat plate, Phase 1's plate, the leaves | - | exactly Lift 2's, bit for bit |
| the dish (R 150) | 6 of 7 (the squiggle refused) | 7 of 7, welds 0.12° against 0.11° |
| bowls R 300 / 150 / 60 / 30, bars 2 - 20 mm | 7 / 5 / 2 / 0 of 8 | 8 of 8 each; welds within the bowl's own (0.06 / 0.12 / 0.31 / 0.66° against 0.06 / 0.11 / 0.29 / 0.57°) |
| noisy paper +-0.08 / +-0.16, 0.2 mm layer steps | all lift | all lift; no weld bends more than the surface's own worst; each says its surround is rough |
| canonical checker | | a spike, the ball after it, the bare ball, the dome after all ten, the plaque, a cylinder spike and the cylinder after it - each PASS, 0 piercing, 0 coplanar |

**Where slantwise bites** (the 35°): measured on the ball, a bump read from
the click beside it (10 - 14° off) is within 0.001 - 0.027 mm; at 28 - 33°,
0.049 mm, welds within the surface's own; at 42 - 50° off, closed and
volume-exact but 0.10 - 0.25 mm of skirt is left. So past 35° it says to
click nearer.

### In the real app (`lift:curved-drive`, 23 gates)

Pick on the spiky ball (Phase 1 calls it curved, the map reads it with Lift
3, the spike beside the click offered "lifted along the surface it stands
on", the rest can't-lift in words); a click on the spike, Lift: one closed
piece on free plate, the ball closed, every new corner within 0.0008 mm of
the sphere, every other triangle as it was, ONE undo step, ball + piece = the
original; Ctrl+Z bit for bit. Strip on the domed plate: 8 small dots, 1 line
or squiggle, 1 large shape, 0 can't lift; Lift 10 - ten closed pieces, the
plaque's note in the read-out, a fresh read finds nothing; Ctrl+Z bit for
bit; Remove 10; Ctrl+Z bit for bit.

**Lift 2's drive check.** Five of its 40 gates said the dish's squiggle is
refused as bending - the limit this ticket removes. They now say it lifts
(seven offered, Strip 6 dots + 1 squiggle, Lift 7, nothing left standing).
Every other Lift 2 and Phase 1 gate is as it was.

### Not here

- **Lift as a reusable skin** - keeping what was lifted (or the texture under
  it) to stamp on another surface. A later ticket; nothing here keeps or
  re-applies a lifted skin.
- A detail too far round the curve from the click is refused, not re-aimed:
  clicking nearer it reads it straight on.
- A lifted piece keeps the curved back it came off with; flattening it for
  printing is not done.

## 7. Lift on the plate - the Subtract card

Lift moved out of G-scope onto the plate. The engine is unchanged; this is
only where and how it is driven. `app-lift-plate.js` (`window.NSO_LIFT_PLATE`),
`app-gscope-lift.js` (now G-scope's read-only **Features** row),
`tools/nso_lift_plate_fixtures.js` (the Barocke plate),
`tools/nso_lift_plate_drive_check.js` (`lift:plate`) and
`tools/nso_lift_plate_drive_lib.js` (the page helpers the four Lift drives
share).

### The verb

**Subtract -> Lift.** Arming it on a selected piece runs detection once: the
rolling ball of section 5 (`NSO_LiftAuto.analyse`, `{ curved: true }`, so a
curved base is section 6's fill), looking straight down onto the piece - the
world's up carried into its raw frame, raw +Z for a piece lying as it was
made. The base face is not clicked: the seed is the face looking up (within
20 degrees) with the most area at one height, then the next, so a seed on a
feature is never used. The answer is cached per piece soup (a `WeakMap` keyed
by `m.rawTris`), so it holds until the piece changes; an Undo that puts a soup
back finds it read already. The card says **"N features found"** - liftable
and standing out more than **How far out counts** (0.42 mm, as before).

- **Pick** (the default). Hovering the piece outlines the feature under the
  cursor, yellow (the islands are the engine's: one whose surround leans more
  than 35 degrees off the view is refused, said in words). A **click** lifts
  it. **Shift**-click gathers several (magenta) and they lift together when
  Shift is let go. Each click, or each Shift group, is one Undo.
- **Strip.** One button: a short untick list with the grouped breakdown -
  `line ×1 · large shape ×1 (12 parts) · dots ×20 · bare plate` on the Barocke
  plate; the last item is what the plate is left as ("the plate keeps 20" with
  the dots unticked). **Confirm** lifts every ticked feature in one step, one
  Undo; **Cancel** changes nothing. The parts of a large shape are the
  engine's necks (data only, nothing splits it).
- A click on another piece points Lift at that piece (and selects it).

A lift is section 2's, unchanged: the piece keeps its place and id and is
repaired (flat where a feature stood, or the surface carried across on a
curve); each feature becomes `<piece> - lifted N` - an ordinary piece: Pieces
list, Move, Join, Export, Remove - **exactly where it stood** (`landInPlace`:
the parent's pose, the mesh where the parent drew those raw triangles). A
feature on top of a slab is left resting on the leftover slab, in the air over
the bed, and stays there - the floating state, `docs/GRAB-DROP.md` - until it
is grabbed and dropped or sent To plate. (Until grab and drop it went onto
free plate beside the parent, `nsoFreeSpot`.)
One `featureSwap` Undo puts it all back. **Remove** (throw the features away)
has no button on the plate; `NSO_LiftAuto.remove` is unchanged and
`lift:auto-test` still holds it.

Refusals are in words, as before: a painted piece ("Lift stood down - N
painted face(s) ..."), a piece with no raw soup or whose mesh does not match
it, nothing found ("Nothing found on <piece>: nothing stands out of its top
more than 0.32 mm."). A feature past the 35-degree view reads "it stands
where the piece slopes too far away from looking up (35° is the most Lift
reads) - turn the piece so that side faces up": the engine's own words for
that case tell G-scope's user to click nearer it, which the plate has no use
for.

**Paint scope: WHOLE-PIECE** (`nsoMaskCount(m) > 0`), declared in
`app-lift-plate.js`'s header and in `nso_paint_scope_test.js`'s roster.

### Any face

Lift is not only for the top. While it is armed **the base face is the face
under the cursor**: hover a side wall and the card reads *that wall* - its
features standing out sideways - "N features found" follows, Pick outlines and
lifts from it, Strip strips it. `app-lift-plate.js` only; the engine already
read a map looking down any normal (`analyse`'s `normal` option), and what a
lift does is section 2's, unchanged.

- **The default is the top** - the face the piece lies with up - read at arm
  time exactly as above (the seeds of the face looking up, biggest first). A
  triangle that looks up within 20 degrees of the view is the top, always, so
  hovering a dot, the paper or a leaf of the plant never leaves it: the Barocke
  plate counts the 22 it always did.
- **A face is a plane**: the triangles that share a normal (to 3 places) and a
  height along it (to 0.05 mm, the plane and the bins either side of it, so a
  plane on a bin's edge is not split). It is read from its own biggest
  triangles (three, in turn - the first read with islands wins, as the top's
  seeds do). It is named by its plane, not by a triangle number, so it
  survives a lift or an Undo (the soup changes; if the face is gone the card
  falls back to the top).
- **A face to read from must be a face**: at least 2 % of the piece's surface
  (`FACE_MIN_FRAC`). A hinge leaf's end, a facet of a cylinder, is not a base;
  hovering it leaves the face as it was.
- **A feature of the face being read leaves the face alone.** Hover the hinge's
  knuckle while its wall is read and the knuckle is outlined (the wall is not
  swapped for one of the knuckle's facets); hover a triangle that is not a
  feature of the face read and the face under it becomes the base. A click on
  a bare face reads it and lifts nothing - the lift is a second click.
- **Off the piece, the top.** The cursor over the viewport but off the piece
  goes back to the top. The cursor leaving the viewport for the card or a menu
  keeps the face, so Strip strips what was shown. Strip's list freezes the
  face while it is open; a Shift group gathered on one face is dropped when the
  face changes.
- **Cached per face**: one read per soup and face (`detectFace`; the top's is
  `detectSoup`'s). Reading a face writes nothing and costs no Undo step.
- **Said once, on the card.** A face with nothing on it reads **"Nothing stands
  out from this face."** - one line - on the card only; the HUD is not made to
  repeat it, and it is cleared when the card changes face (it used to keep the
  last face's words under the new face's). (The top, the default, keeps the words it had: "Nothing found on
  <piece>: nothing stands out of its top more than ...".) The base face being
  read is tinted while it is not the top.

**`feature-hull_hinge.stl`** (a 120 x 70 x 40 box, a print-in-place knuckle
hinge on its +Y wall): the top reads 0; the +Y wall reads **1** - the knuckle
(its two fixed halves and the pin, one feature of 408 triangles, a line 10.5 mm
out of the wall). The free moving leaf, which does not meet the wall at all,
was found and refused in words ("where it meets the face does not close into
clean loops"); since section 8 the knuckle holds it and it comes along. The
wall reading it needed one guard in the engine:
`judge` in `nso_lift_auto.js` took the biggest boundary loop of an island with
none and threw; an island with no loops is now the existing `loops` refusal.
Lifted, the knuckle (with its leaf, section 8) is a closed piece on free plate
beside the hull, the hull repaired and closed (hull + piece = the original
volume, 347468.017 mm³), one Undo; grabbed and dropped it stays where it was
dropped.

### G-scope: Features, read-only

The row is **Features**: the features Lift would find on the piece under the
lens - G-scope's one selected object, else the plate's selected piece, else
the biggest object - outlined over it in their group's colour, and the
grouped list. No Pick base face, no Lift, no Remove, no Clear choice, no
slider (it reads the card's). It reads the same cache through
`NSO_LIFT_PLATE.detectSoup`, so the two always count the same. A document that
is not the plate is read off its own triangles, looking down its Z.
**Paint scope: none** - it writes nothing.

### The Barocke plate (`tools/nso_lift_plate_fixtures.js`)

A 70 x 50 height-field slab at 0.3 mm (157,244 triangles), paper at z = 3: a
line 50 x 1.2 x 0.6 along the front; a plant - a curving stem, eleven leaves
and a bud, one body 0.8 high, read as one large shape of 12 parts; and 20
dots (2.2 mm across, 0.6 high) round the back and sides. Detection reads 22
features in about 1.8 s; the second read is the cache.

### In the real app (`lift:plate`, 1280 x 800)

Arm on the selected plate: "22 features found", the read not from the cache;
off and on again: the cache. Hover a dot: outlined; the bare plate: nothing;
a leaf: the whole plant. A click on a dot: one piece, closed, exactly where it
stood (the box the plate drew it in, 3 mm over the plate's bottom, in the air,
liftY saying so), the plate closed, volumes add up, ONE undo step, 21 left;
Ctrl+Z: bit for bit, 22 from the cache. Shift-click two dots: gathered, then
one step on letting go, each where it stood. Strip: three ticked rows, the breakdown above,
"Confirm - lift 22"; dots unticked: "the plate keeps 20", lift 2; Cancel
changes nothing; Confirm lifts the line and the plant in one step, where they
stood, 20 dots stay. The lifted line moves 5 mm and joins the plant ("Join ok"). G-scope:
the row is Features, 22 - the same count, from the same cache - the grouped
list, an outline per group, no controls. Refusals: a plain box (nothing
found), a painted plate, a piece with no raw soup.

### In the real app (`lift:any-face`, 1280 x 800)

`feature-hull_hinge` through Import: armed, the top reads "0 features found".
Hover the +Y wall: the face read is the wall (normal +Y, 4544 mm²), "1 feature
found", the wall tinted and the knuckle outlined, the first read of that face;
the cursor off the piece goes back to the top; the wall again is the cache.
Hover the knuckle: outlined, the wall still the face. A click lifts it: one
piece, closed, on free plate; the hull closed; hull + knuckle = the original
volume; ONE undo step; Ctrl+Z puts the hull back bit for bit and the wall
counts 1 from the cache. Lifted again and grabbed with the mouse, dragged to
free plate (clear of the app's 12 mm neighbour magnet) and dropped: it is where
it was dropped, closed, on the bed. Strip: off on the top, on for the wall -
"line ×1 + 1 captured part · bare plate", Confirm - lift 1 - one step. The
cursor onto a card button keeps the face; over the empty viewport it returns to
the top. The +X end wall: the card says "Nothing stands out from this face." and
nothing else, and the HUD is cleared. The Barocke plate: the top still reads 22
(`line ×1 · large shape ×1 (12 parts) · dots ×20`) however it is hovered.

`lift:drive`, `lift:auto-drive` and `lift:curved-drive` drive their fixtures
the same way now: G-scope's Features row read-only (a click on G-scope's
canvas lifts nothing), the lifts through the card.

## 8. Lift keeps an assembly together

A print-in-place assembly stays an assembly. A hinge's leaf rides on a pin
through a knuckle; a ring sits on a post; a pin sits in a bore. None of them is
joined to the other, so each is its own **shell** of the piece - and until now
Lift took the part that was fused to the face and left the rest behind on the
parent as a floating shell, or refused it. Now a lifted feature brings its
captured parts with it, as **one piece with several shells**.

**The rule** (engine: `assemble` in `nso_lift_auto.js`, run at the end of
`analyse`). A shell is a set of triangles joined edge to edge. The **base body**
is the shell of the face being read. Every other shell is *free*. A free shell
is **captured** by a liftable feature when

- it lies **within the feature's bounding box inflated by 2 mm**
  (`captureMm`), or
- its bounding box **overlaps** the feature's (it interlocks with it).

A leaf on a pin through a knuckle, a pin in a bore and a ring on a post all
qualify. A shell is held by ONE feature: the one whose box centre is nearest.
Boxes are the feature's own (its island), not grown by what it already holds.

**What a lift does with them.** Nothing is fused and nothing moves. The lifted
piece is the feature (its triangles + the cap on its back, as always) **plus
every captured shell, copied triangle for triangle**: same corners, same gaps,
so it prints in place exactly as it did on the parent. The parent loses the
feature and its captured shells and is repaired **only where the feature stood**
(the same cap as before); every other triangle is as it was. Plate + piece =
the source, exactly. **One Undo** restores parent and assembly bit for bit.
Remove (the engine's discard) takes the assembly too, so nothing is left
floating.

**Where it shows.** The islands the engine reports are the features: a free
shell that is held is no island of its own any more (it was "1 can't be lifted"
before) - its triangles belong to the feature that holds it, so hovering the
leaf is hovering the knuckle. A feature that holds parts carries `partCount` and
`parts` (their triangles and boxes). The card, in plain words, no engine terms:

> 1 feature found — a line with 1 captured part
> 2 features found — 2 with captured parts (3 in all)

and the read-out / Strip's list say "line ×1 + 1 captured part". Hover says
"A line, 10.50 mm high, 64.0 mm², with 1 captured part - click to lift it".
Pick (a click), Shift-click (gathering) and Strip all lift through the same
call, so they all bring the assembly: "Lifted 1 feature off feature-hull_hinge
with 1 captured part (still separate shells, gaps as they were) ...". The hover
fill and the Shift/Strip fill cover the captured shells too.

**Refusals stay honest.**

- A shell that **nothing holds** - floating, outside every feature's box - is
  still "can't be lifted", now with a reason that is true for it: *it is a
  separate part, joined to nothing, and no feature on the face holds it - it
  does not stand on the face* (status `floating`; it used to borrow `loops`,
  "where it meets the face does not close into clean loops", which said
  nothing about it). A plate with only such a shell reads "0 features found"
  and lifts nothing.
- A shell **connected to the base body** is body, as before - it is never
  captured.
- A feature that holds a shell that is **not a closed solid** is refused ("a
  part caught in it is not a closed solid, so the assembly would not come off
  whole") rather than lifted without it, which would leave it floating on the
  parent.
- The top face of the hinge hull still reads 0: no feature on it holds the leaf,
  so nothing is brought along and the read is as it was.

**The HUD.** It is cleared when the card's reading changes face. It used to
keep the previous face's text while the card showed the new one.

### Checked on (`lift:assembly`, 64 gates, 1280 x 800)

Shells are counted in the check by a union-find over exact corners, which shares
no code with the engine.

| fixture | result |
|---|---|
| `feature-hull_hinge.stl`, +Y wall | **1 feature, 1 captured part**: "1 feature found — a line with 1 captured part"; the file has TWO shells (the hull with its fixed knuckles and pin, 432 triangles; the moving knuckle + leaf, 288). Lift: one piece of **2 shells** (700 triangles, closed), the leaf exactly its source triangles, the gap between the shells 0.5000 mm before and after; parent closed, manifold, ONE shell, 28 triangles, chi 2; parent + piece = 347468.017 mm³; one Undo, bit for bit. The 3MF export of the piece: one object, 2 shells |
| the same, Strip | "line ×1 + 1 captured part · bare plate", Confirm - lift 1: the same piece, one step, one Undo |
| the same, top face | 0 features found, nothing captured (no feature there holds the leaf) |
| `posts()` (`tools/nso_lift_assembly_fixtures.js`): a 70 x 40 x 4 plate, post A with two collars, post B with one, a stray cube | "2 features found — 2 with captured parts (3 in all)"; the stray is the one "can't be lifted" (floating). Pick on A: one piece of **3 shells** (the post and its two collars, collars bit for bit, gaps within 0.01 mm), parent closed with 3 shells left (plate + post B, B's collar, the stray); Shift-click both: pieces of 3 and 2 shells in ONE step; Strip: the same, "large shapes ×2 + 3 captured parts · the plate keeps 1"; each one Undo, bit for bit. Export of A's piece: one object, 3 shells |
| `stray()`: the plate and the cube alone | 0 features found; the cube refused with its reason; a click or `lift()` changes nothing; Strip stays off |

**One number differs from the ticket.** The ticket expected the hinge to give
"1 feature with 2 captured parts" and a lifted piece of 3 shells. The file has
two shells (`features.json`: "a print-in-place knuckle hinge ... 2 bodies"; the
pin is fused to the two fixed knuckles, the moving knuckle and leaf are one
body), so there is one captured part and the piece has two shells. The 3-shell
case (a base feature + 2 captured parts) is the posts fixture's post A.

**Limits, in the open.**

- The rule is the ticket's: a bounding box overlap is enough, so a big free
  shell whose box happens to enclose a feature's box (a loose frame round the
  part) is captured by the feature nearest its centre. Boxes are boxes.
- The feature must itself be found. In the height map a post that is wholly
  inside a ring's bore, seen from above, was not found as a feature at all
  (seen with the first version of the posts fixture; the map starts islands
  next to the face, and the ring closes the post off from it). The posts
  fixture gives its posts a head, as a real print-in-place collar needs one to
  stay on, and then the post is found and the collars come with it.
- The refusal for a part that is not a closed solid was checked by hand (a
  collar with a triangle removed: the post reads "a part caught in it is not a
  closed solid", the collar "it runs into an open edge of the mesh"); no gate
  holds it yet.
- A part held by an already-captured part but not by the feature itself (a latch
  on the leaf that does not reach the knuckle's box) is not held: capture is by
  the feature's own box, not transitive.
