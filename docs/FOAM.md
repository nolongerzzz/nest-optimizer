# Foam - spray foam into a hollow, see it fill, bond it solid

`nso_foam.js` (the geometry, headless, `window.NSO_Foam` and a Node module),
`app-foam.js` (the Foam button, its panel, the ghost view and the spray),
`tools/nso_foam_fixtures.js`, `tools/nso_foam_test.js`,
`tools/nso_foam_drive_check.js`.

```
npm run foam:test     headless: one cavity, two cavities, a stepped cavity that splits into
                      pockets, a round one, a hollowed one, poses (on its side, tilted 15°),
                      a captive solid, an open cup, a solid piece, paint; the canonical
                      checker on every result (230 gates, ~5 s)
npm run foam:drive    the real app in Chromium: click Foam, HOLD the mouse on the piece,
                      let go, the slider, Set, Undo, Fill it all, Cancel, choosing a hollow
                      by a click in the ghost view, the refusals (36 gates, ~32 s)
```

Both are in `npm test`.

## 1. What it is

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

- **The cut is the cut engine's.** `rawCut` (app-cut.js) - weld, snap to the
  plane, clip, `rawNestLoops`, `rawFlatCapLoops`, split degenerates - cuts a
  solid, so the hollow's shell is turned inside out (the void as a solid,
  wound outward), cut keeping the side above the level, and turned back. Its
  cap, which faces down out of the void-solid, faces up into the void once
  turned back. No general boolean is involved: it is a plane through one
  closed shell. (rawCut's `keepMin = true` keeps coordinate **>=** the plane;
  the name reads the other way. See `cutVoid` in nso_foam.js.)
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
- Filling open vessels (a cup from its floor up to a level) - refused in words.
- Thin-wall beef-up (foam to thicken a wall from inside).
- A prompt on other tools ("this piece is hollow - foam it first?").

## 9. Version tags

`nso_hollow.js?v=foam1`, `nso_foam.js?v=foam1` (new), `app-core.js?v=foam1`,
`app-foam.js?v=foam1` (new), `app-input-mode.js?v=foam1`, `styles.css?v=foam1`.
