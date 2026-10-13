# Lift, phase 1 - take any detail off a flat face, leave the face flat

`nso_lift.js` (the geometry, headless, `window.NSO_Lift` and a Node module),
`app-gscope-lift.js` (G-scope's sidebar section, "Features - lift off a flat
face"), `tools/nso_lift_fixtures.js`, `tools/nso_lift_test.js`,
`tools/nso_lift_drive_check.js`.

```
npm run lift:test     headless: the plate, every detail alone and all together, the ring,
                      refusals, an off-axis pose, the Picture slab, the canonical checker (771 gates)
npm run lift:drive    the real app in Chromium: real clicks in G-scope, Lift, Ctrl+Z,
                      the slider, a curved face, two Picture slabs (58 gates)
npm run lift:shots    lift:drive, keeping its screenshots in tools/lift-out/ (gitignored)
```

Both checks are in `npm test`.

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
**Features - lift off a flat face** section:

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
