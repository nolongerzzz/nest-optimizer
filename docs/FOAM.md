# Foam - spray foam into buried space, see it fill, bond it solid

`nso_foam.js` (the geometry, headless, `window.NSO_Foam` and a Node module),
`app-foam.js` (the Foam button, its panel, the ghost view and the spray),
`tools/nso_foam_fixtures.js`, `tools/nso_foam_box_fixtures.js`, `tools/nso_foam_test.js`,
`tools/nso_foam_box_test.js`, `tools/nso_foam_drive_check.js`.

```
npm run foam:test     headless, two files:
                      nso_foam_test.js - the sealed-hollow Foam: one cavity, two cavities, a stepped
                      cavity that splits into pockets, a round one, a hollowed one, poses (on its side,
                      tilted 15°), a captive solid, an open cup, a solid piece, paint; the canonical
                      checker on every result (231 gates, ~4 s)
                      nso_foam_box_test.js - foamBox (§10): box_closed.stl merged and filled, a box
                      larger than the piece, cups (square, stepped and slanted rims), a box half in a
                      wall, two voids, amounts, a yawed box, a posed piece, refusals, paint, nothing
                      outside the box changes, 90 random boxes against exact oracles, timings
                      (158 gates, ~11 s; --vase also times the 1.44M-triangle vase)
npm run foam:drive    the real app in Chromium: click Foam, HOLD the mouse on the piece,
                      let go, the slider, Set, Undo, Fill it all, Cancel, choosing a hollow
                      by a click in the ghost view, the refusals, and the GUN (sections 10-15) (70 gates, ~97 s)
```

Both are in `npm test`.

## 1. What it is

**foamBox** (§10) is the engine under all of it: foam as a stock generator bounded by
a box, the way Extract bit is a cutter bounded by its bit. Given a piece and a box
(Crop's Box: centre, size, yaw) it fills every bit of empty space in the box that is
**buried** in the piece and welds to every face it meets. The Foam card below is its
sealed-hollow case; the ADD card that sprays a box is the GUN (§11).

Fill / Densify (`nso_hollow.js` `fill`) stays exactly as it is: one click, every
enclosed cavity gone, nothing to see. Foam is its visible, partial counterpart.
A hollow piece that is about to be carved should be filled solid first, and the
person should see that happen: Foam fills one enclosed hollow from its lowest
point up to a **level**, like a liquid rising, in a visible orange foam, and on
**Set** the foam becomes real solid mesh, bonded into the one piece.

| term | what it is, exactly |
|---|---|
| **hollow** | a shell that bounds a closed void inside the piece: `nso_hollow.js` `cavityShells()`, the very test `fill()` runs (inward-wound, and stepping off it the way its normals do not point lands in material). `fill()` was refactored to call it, nothing else changed; `npm run hollow` (107 gates) is unchanged. A captive separate solid (a rattle's ball) is wound outward and is never a hollow. |
| **up** | the plate's vertical as the piece lies: world +Y taken through the placed mesh's pose into its local frame, then into raw axes by `nsoRawDirFromLocal` (app-mask.js). Unposed, raw +Z. A piece on its side foams along its own -Y; a piece laid on a slanted face foams along a slanted direction. |
| **level** | a height along up, measured from the hollow's lowest point. 0 is the floor; the hollow's height is the top. |
| **volume** of a hollow | its empty space: the shell's volume less any captive solid inside it. The list and the readout use this. |

## 2. The geometry

Set cuts the hollow's shell with the flat plane at the level. The part of the
hollow **above** stays a hollow; the cut is closed with a flat **floor facing up
into what is left of the void**. Below the level is solid.

- **The cut is foamBox's** (§10), with the box the hollow's own bounds: the void is
  this hollow's shell turned inside out (wound outward), cut by the plane at the
  level, the cut closed with a flat cap - rawCut's clip and cap (app-cut.js) on
  exact shared corners - and turned back. Its cap, which faces down out of the
  void-solid, faces up into the void once turned back. No general boolean is
  involved: it is a plane through one closed shell. The **preview** (§3) is still
  `rawCut` through the same void-solid (`keepMin = true` keeps coordinate **>=**
  the plane; the name reads the other way. See `cutVoid` in nso_foam.js).
- **Everything else is untouched, vertex for vertex.** Every triangle not on
  this hollow's shell is copied in its own order; the hollow's remaining walls
  follow. The outer surface, other hollows and captive solids come back bit
  for bit (gated on every case).
- **Level at the floor** changes nothing: the input soup is handed back.
- **Level at the top** drops the shell whole and appends nothing - exactly
  `fill()`'s drop-and-copy for that shell, so on a one-hollow piece it is
  Fill / Densify's output bit for bit, and two hollows foamed to the top one
  after the other is Fill's output for both (gated).
- **Pockets.** A hollow that splits above the level (a chamber with two
  chimneys) comes back as separate closed shells, one per pocket; each is a
  hollow in its own right afterwards, with its own volume (gated against the
  voxel count).
- **A slanted up** is handled the way Lift handles a slanted base: the shell
  goes into a frame where up is +Z, is cut there, and every corner the cut did
  not make maps back to the raw vertex it came from. When up is a raw axis the
  frame is a permutation with signs, exact in floating point.
- **Captive solids.** The foam may rise past one, holding it in the foam the
  way Fill leaves it held in the solid (its own shell, untouched). Its surface
  may not stop **inside** one - the floor would cut through it - so Set refuses
  that level in words: "the foam's surface would run through the loose solid
  inside hollow 1 (it sits from 10.0 to 20.0 mm above the floor). Set the level
  below 10.0 mm or above 20.0 mm." The readout while rising counts only empty
  space.
- **The result is checked** before it is handed back: closed, 2-manifold,
  no degenerate triangle, by exact corners (nso_lift.js's census rule). A
  piece that came in closed and would not go out closed is refused.

## 3. Seeing it

While Foam is on (`app-foam.js`):

- the piece is a **ghost** - translucent (0.2), depth-write off, not
  wireframe: X-ray's treatment without the wires. Its materials are saved and
  put back exactly; X-ray skips the piece while Foam has it.
- each hollow is a **dark void**, the chosen one darker;
- the **foam** is the chosen hollow's volume below the level (`preview()`:
  rawCut keeping the void below the level), drawn orange and slightly bubbly
  (a canvas tile of bubbles as colour and bump, box-mapped), translucent;
- a thin bright **ring** where the foam's surface meets the wall;
- the readout: **"Foam: 42% of the hollow, 7,396 mm³"**.

Nothing on the piece is mesh until Set. On Set the piece is committed through
`NSO_sculptCommitRaw` (one undo entry, `foamReplace`, "Undo: Foam reverted"),
the fresh piece flashes orange and fades back, and the view returns to normal.

## 4. Controls

In **Finish → Shape**, in Fill / Densify's row (`vp-row-pair`). When the bars
are reorganised it moves into the new button column; that is not built here.

| control | what it does |
|---|---|
| **Foam** | turns Foam on (again: Cancel). Refuses in words, and stays off, on a piece with no hollow, an open vessel, a non-solid piece. |
| **Hollows found** | one row per hollow, "Hollow 1 - 17,576 mm³". A click on a row, or on the hollow in the ghost view, chooses it. One hollow is chosen for you; with several, none until you click. Each hollow keeps its own level. |
| **hold to spray** | hold the mouse button anywhere over the piece: the level rises at hollow height / 3 s of wall-clock time, so any hollow fills in about 3 seconds; letting go pauses it. The press is claimed through `nsoFoamTakesPointer`, asked by app-core ahead of Measure, so it never drags the piece or orbits the view. |
| **Level** | the same level, in mm above the floor, 0.01 mm steps. Lower it before Set if the spray went too far. |
| **Fill it all** | the level to the top. |
| **Set** | commits; see §3. |
| **Cancel** | Foam off, the piece exactly as it was, no undo entry. Escape, a double-click (leaveTool), another selection or any change to the piece's soup do the same. |

## 5. Refusals, in words

| case | what the person reads |
|---|---|
| no hollow | "Foam: this piece has no enclosed hollow - it is solid all the way through, so there is nothing to fill. Nothing changed." |
| open vessel (a cup, a vase, a pocket) | "Foam: this piece's hollow is open to the outside, like a cup or a vase. Foam fills a sealed hollow only - open vessels come later. Nothing changed." Found by a 16³ grid of points in the piece's box that are not in material and have the piece below them and on all four sides (rays along -up and ±e1, ±e2). Two such points call it open. A bracket's corner or a channel escapes sideways; an arch has nothing below it but the plate. |
| an inward shell Fill cannot confirm | "Foam: this piece has 1 inner shell facing inward that Fill / Densify's test could not confirm as a sealed hollow - it is not sitting inside material, which is what a separate body saved inside out looks like. Foam finds hollows the way Fill does, so it leaves it alone. Nothing changed." Asked before the open-vessel probe, which would otherwise call it open. Wall thickness no longer lands here (§7.1). |
| non-solid flag | "Foam does not apply to "<name>" - it is flagged non-solid, so it has no closed inside for foam to fill. Nothing changed." |
| a level through a captive solid | §2. |
| a painted wall | §6. |

## 6. Paint scope: SUB-REGION

Per the scoping rule in docs/HANDOFF.md. Foam changes only the faces of the
hollow it fills that the level reaches: any face with a corner below the level
(plus the cut engine's 1e-4 mm weld band), and at the top every face of the
shell. Only those are checked, against `nsoMaskFaceList(m)` - the skip list as
the clicks recorded it, read and never re-derived. A face matches an entry when
its normal is the entry's axis and side and its plane is the entry's, within
app-mask.js's own tolerances (0.02 on the normal, 0.05 mm on the plane). A
match stands Foam down and names the face in the app's own words
(`nsoMaskFaceName`): "Foam stood down - the inner Y+ face at -13.00 is painted,
and it is a wall of hollow 1 the foam would change." Paint on the outer surface,
on another hollow, or on this hollow's ceiling while the level is below it does
not. `nsoMaskFaceList` returns null when a painted recessed patch has no axis
and side; Foam then stands down and says so rather than guess. The module takes
the skip list as a **required** input - `foam()` without one is refused - so
"unpainted" is never the value a caller gets by forgetting.

## 7. Limits, stated rather than implied

1. **Thick-walled hollows are found** - fixed in `cavityShells`, so for Fill /
   Densify too. The "sits in material" half of the cavity test steps off a
   face by a quarter of its measured wall; that wall used to be measured with
   nso_thickness.js's 5 mm default probe, and a hollow every one of whose
   walls was thicker read as "mis-wound, not inside material" (a 40 mm cube
   round a 10 mm hollow: Fill "nothing to fill", Foam 'unconfirmed'). The
   probe now reaches the piece's box diagonal - behind a real cavity wall
   there is always the outside of the piece - and a face whose probe still
   finds nothing votes "not in material". A captive solid is still never a
   cavity (it is wound outward), and one saved inside out is still not one
   (the step off it lands in the void). Gated by
   `tools/nso_cavity_thickwall_test.js` (`cavity:thickwall`).
2. One hollow per Set, by design ("each foamed on its own").
3. The preview recomputes the cut every frame the level moves. On the
   fixtures that is well under a millisecond; on a hollowed piece with ~12k
   cavity triangles it is a cut of that shell per frame.

## 8. Flagged, not built

- Freehand blobs (foam sprayed at a spot, not filling a hollow).
- Filling open vessels from the Foam card - refused there in words. foamBox (§10)
  fills them; the GUN (§11) is its ADD card.
- Thin-wall beef-up (foam to thicken a wall from inside).
- A prompt on other tools ("this piece is hollow - foam it first?").

## 9. Version tags

`nso_hollow.js?v=foam1`, `nso_foam.js?v=foam1` (new), `app-core.js?v=foam1`,
`app-foam.js?v=foam1` (new), `app-input-mode.js?v=foam1`, `styles.css?v=foam1`.
foam-gun: `nso_foam.js?v=foambox1`.

## 10. foamBox: foam in a box, bounded by the piece

```
NSO_Foam.foamBox(piece, box, amount, opts)      -> Promise of the result below
NSO_Foam.foamBoxSolid(piece, box, amount, opts) -> the same, now, on the piece as one solid as it is

piece   { rawTris, toRaw?, name?, skipList }   rawTris in the piece's raw axes; toRaw (16 numbers,
                                               column-major) maps the plate frame P into them, as Crop
                                               takes it; skipList nsoMaskFaceList(m), REQUIRED
box     { c: [x, y, z], h: [hx, hy, hz], yaw } Crop's Box, in P (mm; yaw in degrees about the vertical)
amount  0..100                                 how far the foam has risen (below)
-> { ok, changed, mesh, addedVolume, touched, level, span, merged, reason, ... }
```

`mesh` is the piece with the foam welded in (raw axes, a new soup); `addedVolume` the mm³ it
gained; `touched` the ids of the piece's shells the foam welds to (shells numbered in the order of
their first triangle; none when the box sits clear of every face and the foam stands free in the
space it filled - the reason says so). Each call takes the previous result, so sprays stack:
50 then 50 is 75 from the start (gated).

### What is buried

Per layer - a flat section of the piece across its up - the piece's outermost contours with their
insides filled, inner contours ignored: the outer boundary a slicer reads. Empty space inside that
outline is buried, sealed or open alike: a cup's bowl is, the air over its rim is not. The foam is
the buried empty space inside the box, risen from the bottom of the buried space in the box to a
level. Nothing protrudes past the piece's surface however far the box sticks out; the box's walls
bound the fill where they are inside the piece, the piece's surface where the box leaves it.
Nothing outside the box changes: every triangle clear of it comes back bit for bit (gated on three
pieces, one with a yawed box).

### How it is found, exactly

- **The outer outlines.** A section's loop is an outer contour when it runs counter-clockwise (an
  outline, nso_slicer.js's rule) and no larger outline holds it; every other loop - a hole's, an
  island's in a hole - borders buried space.
- **One section per slab.** The shape of the section can only change at a **critical vertex** of
  the height on the surface: a lowest or highest point among its neighbours, a saddle (its lower
  neighbours in more than one arc), a pinch (its fan more than one ring). Ties in height are broken
  by corner id, which only adds critical vertices where faces lie flat. Between two critical
  heights every loop only slides, and the faces of one loop's band - found by walking edges inside
  the slab - all face the same side. So one section per slab says which side every face is on. A
  flat face at a critical height asks the section just above it (facing up) or just below it
  (facing down) whether its centre is inside an outline. The vase in §10 timings has 4 critical
  heights; a CAD box has a handful.
- **Cut at a height where the side changes.** A face whose side changes inside its span is cut at
  that critical height (a slanted rim opens at the inner rim's lowest corner, a saddle mid-wall;
  every inner wall of `slantCup` is one tall quad and is cut there).
- **The void.** The faces that border buried space, turned inside out, closed by a flat **lid**
  wherever the buried space ends against air (a cup's rim, a bell's mouth), are a closed solid.
- **The foam** is that solid cut by the box's six faces and then the level, plane by plane, each
  cut closed by a flat cap: rawCut's clip and cap, on **exact shared corners** - a corner made on an
  edge is made once, from the edge's two ends in id order, and every face on that edge uses it. A
  corner within 1e-4 mm of a plane is on it, and corners on a plane within 2e-4 mm of each other are
  welded (rawCut's rule; a made corner folds only into a corner that stays put, never along a
  chain, and an original corner never moves). A cap or lid a later cut crosses is laid again from
  the corners other faces use, so no run of corners collects along the box's edges. No general
  boolean.
- **Setting it.** The void's faces inside the foam go (welded); their parts outside it stay, laid
  again from only the corners something else needs, so a neighbour does not change; the foam's caps
  and lids are added; an untouched face whose edge gained a corner is split at it (it does not move).
  The result is checked closed, 2-manifold, nothing collapsed, before it is handed back.

### Work as is: overlapping shells

`box_closed.stl` (a tray and a lid slab overlapping by 0.1 mm) is merged for this operation only
(`nsoOverlap` in the page; `opts.overlap`, or the kernel's `NSO_overlapMeasure` /
`NSO_shellMergeCore`, elsewhere - docs/WORK-AS-IS.md) and the result is built on the merge: "Foam set -
46,166 mm³ of buried space filled (100% of what the box holds, to 24.9 mm), welded to 2 shells
(box_closed had 2 overlapping shells - merged for this operation)." Today's Foam calls the raw shells
"open to the outside"; foamBox fills them. A box covering the hollow at 100 is today's Foam (Fill it
all) on the merged solid - and Fill / Densify - vertex for vertex. A piece that is not one clean
solid as it lies (shells that only touch, a seam the merge's weld closes) is merged too; one the
merge cannot close is refused in words.

### Decisions the ticket left open

| | decided |
|---|---|
| amount | the level rises through the height of the buried space **inside the box**: 0 is its bottom (the box's floor, or the buried space's own floor if that is higher), 100 its top. A spray shows foam from its first moment, and 50 is half the height, not half the volume |
| the old Foam's Set | foamBox's engine with the box the hollow's bounds and the void **named** - the hollow's shell - so a captive solid (a rattle's ball) stays held on its own shell as Fill holds it, and a level through it is still refused. foamBox itself welds a captive solid in (gated: the 40 mm block, one shell) |
| paint | sub-region: the faces the foam welds to, against the skip list, which is required (it rides on `piece.skipList`, keeping the call at three arguments). A piece that needs a merge stands down for any paint: the merge replaces every triangle |
| a box clear of every face | fills, and says it is welded to nothing - it stands free in the buried space (a box in the middle of a bowl) |

### Results (`foam:test`, tools/nso_foam_box_test.js)

| case | result |
|---|---|
| box_closed, a box covering the hollow, 100 | 46,166.4 mm³ = the merged hollow; = Fill / Densify and today's Foam on the merge, vertex for vertex; touched [0, 1] (tray and lid) |
| box_closed, part of the hollow | 20 × 10 × 22.9 = 4,580 mm³, from the tray's floor to the lid's underside |
| a box larger than the piece | box2's two voids = Fill / Densify bit for bit; the composite (a cup, a post past its rim, a sealed void in its floor) = the cup solid to its rim plus the post, every new face on the rim's outline at z 30 |
| cups, the box out of the top | to the rim (30 mm) and no higher, nothing outside the wall; a slanted rim fills to its inner low corner (16.1 mm, 7,464.74 mm³ = the 48-gon x 14.1); a stepped rim to its lowest step (12,168 mm³) |
| a box half in a wall | 2,000 mm³, the same as the box cut back to the bowl; a sealed hollow 1,000 |
| two voids | both, welded to both void shells |
| amount 25 / 50 / 75 / 100 | box2: 4,800 < 8,800 < 11,200 < 13,600 mm³ |
| random boxes | 30 on the cup and 30 on the composite against the buried cells, 30 on the slanted cup (yawed, random amounts) against the closed form, 12 on box_closed: all within float32's rounding (worst 2.8e-4 mm³), all closed, the canonical checker on a sample |

The canonical checker (`mesh_validate.py --gate`, self-intersection included) passes on every result
it is run on. Offline, 1,000 more random boxes over ten fixtures (yawed, random amounts) gave 788
fills, every one canonical-clean and gaining exactly the volume it reports.

### Timings (Node, the cloud box)

| piece | case | ms |
|---|---|---|
| box_closed (80 tris) | merge + fill | ~20 (the engine ~5) |
| vase, 154,560 tris | the whole vase / a box at its side | ~250 / ~350 |
| vase, 1,442,880 tris | the whole vase, 100 / 40 / a 24 x 20 x 30 box at its side | ~3,200 / ~3,700 / ~4,600 |

The vase is `tools/nso_foam_box_fixtures.js` `vase()`: a flared thin wall with a wavy rim and bumps,
the butterfly vase's size (that file is not in the repository). About a third of the time is
indexing (exact corners, edges), a third the reading of buried space, the rest the cut, the
assembly and the closing census. Nothing is cached between calls yet: a held spray on a big piece
should keep the void for its piece while the amount changes (not done: the GUN, §11, calls foamBox as it is).

### Limits, stated

- A piece whose shells cross is merged (above); a single shell that passes through itself is not
  merged (docs/WORK-AS-IS.md), and its sections' loops cross: it is refused if its buried space does
  not close, in words.
- The amount is by height, not volume.
- The engine has no preview of its own: the GUN (§11) draws the foam from `mesh`.

## 11. The GUN: foamBox from the ADD column

`app-foam.js` (the gun), `app-crop-card.js` (the loan of the Box), `index.html` (`#btn-foam-gun`,
`#foam-gun-panel`). UI only: every number is foamBox's (§10). `tools/nso_foam_drive_check.js`
sections 10-15 drive it in the real page and write three screenshots (box placed, mid-spray, set)
to `tools/foam-gun-out/` (git-ignored: run `npm run foam:drive` to make them).

| step | what happens |
|---|---|
| **GUN** (ADD, beside Foam) | Crop's Box appears on the selected piece, centred, half its size, with Crop's own six handles. There is no field. The Crop card is not opened. |
| **handles** | They place and size the box exactly as in Crop: a handle drags its face, the opposite face stays. A press on a handle never orbits or moves the piece. The box's body does not slide (Crop's body-drag is off while the box is lent): a press inside it is the gun's. |
| **hold** | A press that aims at the piece through the box - the ray passes through the box and meets the piece, so a box buried in the piece is aimed at through its wall - starts the spray. The amount rises 0 to 100 in 3 s of wall-clock time (`GUN_SECONDS`), foamBox is asked at the amount as it stands (one call at a time, the latest amount), and what it returns is drawn: the piece a ghost, the foam orange, from the bottom of the box's buried space up. A press anywhere else is the orbit's. |
| **release** | foamBox is asked once more at exactly the amount reached and its `mesh` is committed through `NSO_sculptCommitRaw` (`foamReplace`): one Undo per spray, "Undo: Foam reverted". The ghost goes, the piece flashes, the box stays. |
| **again** | The next spray takes the piece as it now is (the previous `mesh`) and its amount starts at 0 of what is left in the box: sprays stack. |
| **Escape / Cancel** | The box goes. In the middle of a spray, nothing is set. Sprays already set stay; Undo takes them back one at a time. Another selection, leave-tool, Clear and the helper registry do the same. |

**The readout** (`#foam-gun-readout`) is the volume foamBox returned for the spray (`addedVolume`),
"+3,375 mm³", live while holding and after release, and nothing else: no percent, level, size or
count. A refusal shows foamBox's own reason in its own words (the old Foam's "open to the outside"
message is not asked on this path). The status line carries foamBox's `reason` for a set.

**The foam on screen.** foamBox returns the piece with the foam welded in, every triangle clear of
the foam bit for bit. The foam's skin is the difference of the two soups (what was welded away plus
what was added), drawn clipped to the box's six faces and the level (`level`, the height in the box
frame, which is the plate's up), so the remains of the walls the foam cut fall outside and what shows
is the foam alone.

**Foam and GUN swap.** One is on at a time: pressing Foam while the box is out takes the box away
and runs Foam as it always has (sealed hollows, Level slider, Set); pressing GUN while Foam is on
puts Foam away. Foam's button, panel and messages are unchanged. If the Crop card has a shape out
when GUN is pressed, GUN borrows the Box and gives the card's shape back when it is done; picking
a shape on the card while the box is out takes the box away.

### Decisions the ticket left open

| | decided |
|---|---|
| Foam while a box is out | swap (asked: the owner chose it) |
| moving the box | by the handles only; the body does not slide, because a press inside it is the spray |
| aim | the ray must pass through the box *and* meet the piece; outside that a press is the orbit's / the move drag's (a press on the piece outside the box still starts the usual move drag, as it does under Crop) |
| speed | amount 0 to 100 in 3 s, like the old Foam's 3 s |
| Escape mid-spray | sets nothing and takes the box away |
| readout on a refusal | foamBox's reason, verbatim |
| non-solid flag, paint | nothing added: foamBox decides (paint stands down per its skip list, in its words) |

### Limits, stated

- foamBox is not cached between calls (§10 Timings): a held spray on a piece of hundreds of
  thousands of triangles redraws at foamBox's speed (one call at a time, so it never queues) and the
  final amount is asked once more on release. The skin difference is a hash of every triangle.
- The preview draws the foam as one orange surface; it does not show the buried space it does not fill.
