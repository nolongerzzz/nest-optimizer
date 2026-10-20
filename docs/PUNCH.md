# Punch

Click a face, get a round hole straight through it (or to a depth), and the
same hole repeated in a grid or on a circle. **Engine only so far:**
`nso_punch.js` (THREE-free, node-tested). No card, no button; `index.html`
does not load it yet. Gate: `npm run punch:test`.

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

## Paint scope

Not applicable to the engine: it reads a soup and returns new ones. The app's
Punch will act on a sub-region (the faces the holes go through) and states its
category when it lands (docs/HANDOFF.md).
