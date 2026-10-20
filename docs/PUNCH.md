# Punch

Click a face, get a round hole straight through it (or to a depth), and the
same hole repeated in a grid or on a circle. The geometry is `nso_punch.js`
(THREE-free, node-tested: `npm run punch:test`); the card is `app-punch.js`,
SUBTRACT › Punch (driven: `npm run punch:drive`).

```js
var pl = NSO_Punch.plan(soup, { point: [x, y, z], normal: [nx, ny, nz] }, opts);
// pl = { ok, holes: [{ n, centre, axis, dia, depth, lift, spans }], reason,
//        dropped, droppedHoles, floor, frame: { u, v, n } }
var soups = NSO_Punch.cutters(pl);   // one closed cylinder soup per hole
```

`plan` only reads the soup. A refusal is `{ ok: false, holes: [], reason }`
with the reason in words; the piece is as it was.

## Options

| opt | default | |
|---|---|---|
| `diaMm` | 3 | the hole's flats; under two nozzle widths is refused (it prints shut) |
| `depth` | `'through'` | or mm below the surface |
| `countersink` | `'none'` | the only value for now; anything else is refused |
| `nozzle` | 0.4 | the wall floor is two of these (0.8) |
| `pattern` | `'none'` | `'grid'` or `'radial'`, or `{ type, ...fields }` |
| grid | `rows`, `cols`, `pitchX`, `pitchY`, `anchor` | cols along u at pitchX, rows along v at pitchY; `anchor` `'corner'` (the click is hole 1) or `'centre'` |
| radial | `n`, `R` | n holes on a circle of radius R about the click, the first along +u, counter-clockwise seen from outside |

At most 400 holes, 100 rows / cols / n.

## The face's frame

- **n** is the surface's smooth normal at the click, not the facet's: a click on
  a faceted cylinder lays its pattern square to the cylinder.
- **u** runs along the face's longest straight edge: the longest collinear run
  of rim edges of the flat region the click is on (a slab top's longer side; on
  a cylinder, a facet strip's long edge = the cylinder's length). Laid square to
  n, its largest world component made positive; a tie between equal sides goes
  to the one nearer world X.
- **v** = n x u.

## Each hole

1. The pattern point `p = click + x u + y v` is in the click's tangent plane.
2. Its **footprint** is where the line through p along n meets the **same smooth
   surface** as the click (triangles joined across edges of at most 30°), on its
   front side, nearest p. No footprint (the line misses the piece, or lands on a
   different face: a step down, the slab's side) -> the hole is **dropped**, and
   the reason says how many and which: `3 holes of 12 fall off the face and were
   dropped (4, 8, 12); punching 9 holes Ø3.0 through`. Every hole dropped is a
   refusal.
3. Its **axis** is the smooth normal at its own footprint (angle-weighted facet
   normals round each corner of the footprint's triangle, same surface only,
   interpolated across it). On a faceted cylinder that is exactly radial, so a
   grid on a shell drills each hole square to the surface.
4. **Depth.** The ray in along -axis is walked as stretches of material
   (`spans`, mm below the centre). `'through'` = to its last exit (leaves the
   piece for good), so a tube's hole goes through both walls; the cutter runs
   0.2 mm past each end: a 10 mm slab reads `depth` 10.4. A number d reads
   d + 0.2. The cutter runs from `centre + lift * axis` (lift 0.2) for `depth`
   along -axis.

Holes are numbered by their place in the pattern, from 1, row-major from the
anchor, dropped ones included, so a number in a reason can be counted off.

## Refusals - the wall floor

Two nozzle widths (0.8 mm at 0.4). Measured with the nominal radius:

- **between holes**: closest approach of the two holes' material spans, less
  both radii - `holes 1 and 2 would leave 0.5 mm between them; the floor is
  0.8`, or `would run into each other` (radial through holes on a solid
  cylinder meet at its axis; on a tube they cross in the bore, which is air,
  and are fine).
- **to the piece's edge**: where each span goes in and comes out, the distance
  to the nearest **convex** rim edge of the surface it is on, less the radius -
  `hole 1 would leave 0.5 mm of wall to the piece's edge`. A concave corner
  (the foot of a boss, a pocket's wall) is not an edge to break through.
- **under a blind hole**: the skin left between its bottom and the far face -
  `hole 1 would leave a 0.5 mm skin under it`.

The worst one is named; `(N more places are under it too)` counts the rest.
`violations` lists them all for a card to mark.

## Cutters

One closed, outward-wound cylinder per hole: 48 sides at Ø6 and up, 8 per mm of
diameter below that, never under 16 (Ø3 -> 24). Its **flats** sit at dia / 2
(the corners at dia / 2 / cos(π / sides)), so a pin of the stated diameter goes
in. The app subtracts them in one boolean through the boolean worker
(docs/BOOLEAN-WORKER.md): the gate subtracts a 12-hole grid as one
concatenated soup with the shipped `NSO_subtractSoups`. Cutters that meet in
air (through holes across a tube's bore) overlap, so for those the app should
union the cutters first (or subtract in turn inside the one job) - one Undo
either way.

## Cost

The soup is read once (weld, edges, smooth surfaces, rims) and kept on its
array: 2.3 s for 320,000 triangles, then ~0.3 s a re-plan of 60 holes. Rays use
`NSO_BVH`'s index when it is loaded.

## The card (app-punch.js)

SUBTRACT › **Punch** arms it; a click on a face of a piece places the hole
(a piece not selected is selected by the click). The card:

| row | |
|---|---|
| Ø | default 3.0 |
| Depth | Through ▾ or mm (a Deep field appears) |
| Pattern | None · Grid · Radial |
| Grid | Rows, Cols, Pitch (one field; × splits it into Pitch X and Pitch Y, Y starting at X), Anchor Corner \| Centre |
| Radial | Count, Radius |
| readout | what the plan says; a refusal in red |
| PUNCH / Cancel | |

**Ghost.** Every hole is drawn as the very cutter PUNCH subtracts (amber,
through the piece) with its entry ring on the surface. A hole the pattern lays
off the face is a grey ring where it would have been, and the readout counts
them (`3 holes of 15 fall off the face and were dropped (5, 10, 15) ...`). A
refusal draws the holes it would have made in red, says why, and PUNCH is off.
A cross marks the anchor (the click).

**Handles** (the neck's pattern, #241). The first hole's **ring** is Ø: drag it
out or in. The **anchor** - the hole at the click (None, or a corner-anchored
grid), else the cross - drags across the face, staying on it
(`NSO_Punch.slide`). Grid: the **far-corner hole** is the pitch (one pitch: the
drag's projection on the grid's diagonal; × split: each axis its own). Radial:
**any hole** is the radius. Steps of 0.5 mm, 0.1 with Shift. Hover lights the
handle and names its value in the readout. A press on a handle or on a piece is
taken at the window, ahead of app-core and OrbitControls; a press on bare plate
never is, so the view orbits while Punch is armed (`pick:release`).

**Keys.** The arrows nudge the anchor 1 mm along the face (Shift 0.1), along
whichever of ±u, ±v points the arrow's way on screen. Escape puts a drag back;
with none it disarms. Text fields keep their own arrows and Escape.

**PUNCH.** Every hole in ONE boolean: the cutters go to `NSO_subtractSoups` as
one soup of separate shells (cutters that meet in air - through holes crossing a
tube's bore - are unioned first), so a piece of 50,000 triangles or more goes to
the boolean worker (docs/BOOLEAN-WORKER.md) under its bar. If PUNCH takes longer
than 300 ms Punch puts the bar up itself too (`NSO_BoolBusy`, under the
readout); Escape stops it. A piece of overlapping shells is merged for it first
(`nsoOverlap.solid`, work-as-is). The commit is the sculpt commit, undo type
`punchReplace`: one Undo puts the piece back. The card stays armed: the click
goes, the numbers stay, the next face is a click away.

The piece must be as it was loaded (`NSO_bendFrameMatches`): a click on a piece
turned since is refused in words, as Bend's and Tube edge's ghosts are.

## Paint scope

**WHOLE-PIECE** (app-punch.js header): a hole runs through every face it meets
on its way, curved ones too, and paint names its faces by axis and side, so any
paint stands Punch down, naming the count - `nsoMaskCount(m) > 0`. The engine
itself reads a soup and returns new ones.
