# Bridge — a web from one place to another, welded

`nso_bridge.js` (headless geometry) and `app-bridge.js` (the card), loaded
straight after `app-bend.js` (`nso_bridge.js` at `?v=bridge3`, `app-bridge.js` at `?v=bridge2`). The card is **Bridge** in the
left column's **Shape** drop-down, in the row under Extend and Mirror (Bend
moved to the top row in shell v2).

```
node tools/nso_bridge_test.js           headless: ring -> oval, yawed boxes, square -> round,
                                        spheres, bars, every guard; mesh_validate on every output
node tools/nso_bridge_drive_check.js    the real app: Split, two clicks (orbit between), ghost, Set, Undo, Cancel
node tools/nso_bridge_drive_check.js --shots DIR    also writes DIR/*.png (scratch; nothing committed)
```

Both are in `npm test` (`bridge:test`, `bridge:drive`).

## The verb

Stretch a web of mesh from one place on a piece to another place — on the
same piece or on another one — and weld both ends, so the result is **one
closed solid**. Every web is straight; a curved bridge is Bend's job
afterwards.

What is picked chooses the web. One card, no mode switch:

| picked | web | how it is welded |
|---|---|---|
| face → face | **band**: a ruled loft between the two face outlines | stitched to both faces' loops on the same numbers; no kernel |
| point → point | **string**: a round rod, Ø field (default 2 mm) | ends sunk under each surface, unioned (`NSO_unionSoups`) |
| edge → edge | **sheet**: a flat slab between two straight edges, thickness field | ends sunk 0.5 mm into both pieces, unioned |

When the two ends are on different pieces the result is one new piece in
their place, exactly where they stood. When both are on one piece it closes
on itself (the ring case's second gap).

## The card

Open Bridge and, while it is open:

- **hover** lights whatever Bridge could take under the pointer — a face (its
  triangles, cyan), an edge (a bar along the whole straight edge) or a point
  (a dot) — and the readout names it: `Under the pointer: face, 8.0 × 1.0 mm
  rectangle`;
- **click** on one — it stays marked (gold) — then **orbit, pan and zoom as
  much as you like**: nothing is held or captured, so the camera is free, and
  an amber line runs from the marked place to the pointer meanwhile. Then
  **click** on another: the web is planned at once and drawn as a **ghost**
  (amber, 0.75 — Bend's), from the very soup Set welds. The readout says what it is
  (`Band 20.0 mm, 8.0 × 1.0 mm rectangle both ends · 4/4 → 4 points`), or why
  not, in red, with no ghost and Set off;
- the **Ø** row shows for a string, the **Thick** row for a sheet (its hint
  the default, `auto 5.0`); a change re-plans at once;
- **Set** welds it and stays open for the next one; **Cancel** drops the
  pending web, and pressed with nothing pending closes the card;
- **starting over**: a click on empty space, **Escape**, or a click on the
  marked place again drops the mark (and any web on it). With a web showing, a
  click on another place **moves the second end** there and re-plans; A stays
  marked.

A press that travels more than 4 px is an orbit, not a click, and never picks
or clears anything. A press on empty space is left alone, so the view still
orbits. A press on a target is taken ahead of app-core's canvas handler, so it
does not also select or drag the piece. The card goes away when its
drop-down shuts (one panel at a time), and the picks go when a picked piece moves or changes.

**Each Set is one Undo**, and the Undo puts **every input back as it was**:
the same model objects, the same raw soups bit for bit, the same placed
records, meshes and poses (`bridge:drive` §2 compares all three). It is the
`supportSwap` undo step G-scope already uses — "take these pieces off, put
those back where they were" — so `app-core.js` needed no new branch.

## Picking

Both pieces are read in the plate's world frame, Z up (`meshToWorldSoup`, then
`(x, −z, y)`), so their poses are in the numbers and the result needs none.
Each piece is indexed once per pose (`NSO_Bridge.index`) on Join's vertex
space: `NSO_fuseVertGrid` at `NSO_fuseTolerance`.

A click at a point on a triangle picks, in this order:

1. **an edge** — within 8 screen pixels (in mm at the hit's depth), capped at
   a quarter of the face's narrower span, of a straight rim edge of a face. The
   whole straight run of rim edges lights, not one triangle edge;
2. **a face** — the flat region grown from the triangle (neighbours within
   0.5° and on its plane) **whose whole rim is creased at least 20°**: a cut
   face, an Extend end, a box side. The cap of a 1 mm-wide cut face is a face;
3. **a point** — anything else: a curved surface, or a facet of one.

The 20° rule is what makes a sphere's facets points and a box's sides faces.

## Band (face → face)

1. **Pair the outlines**: outline with outline, each hole with the nearest
   hole. Different counts are refused.
2. **Resample to one vertex count**: both outlines are parameterised by arc
   length, the second one run backwards so both go round the same way seen
   down the gap. The stations are **every vertex of either outline, nothing
   else** (two within 1e-4 mm of each other merge).
3. **Match by nearest rotation**: the shift `s` that puts B's point at `t + s`
   nearest A's point at `t`, each measured from its own outline's centroid,
   over every vertex-onto-vertex candidate. That is the rotation that does not
   twist the band. Identical parallel faces match point for point with zero
   shift: a plain straight band and no new points (the ring case).
4. **Ruled surface**: each pair of neighbouring stations is a quad, split on
   its shorter diagonal.
5. **Stitch**: both faces' cap triangles go. A station that is not a vertex of
   its own outline lies on an outline edge, so the wall across that edge is
   **split** to take it (fanned from its opposite corner, or from its centroid
   when two of its edges take points) — no T-junction is left. The band's
   triangles carry the caps' own half-edges, so they wind outward.
6. **Weld**: every loop vertex is snapped to one canonical value, the first
   piece's — `NSO_planarFusePair`'s seam weld — so the result is closed by bit
   equality.

## String (point → point)

A round rod along the straight line between the two points. Sides: enough that
a side's sagitta stays under 0.01 mm, 16 to 96, even. Each end is sunk by
**Assemble's own seat measure**: the rod's rim, laid at the point,
goes through `NSO_Assemble.rootGap` (which asks `nso_support_aim.js`'s
`nearestBase`), and the end goes under the surface by that gap **plus 0.5 mm**.
The rod is `NSO_PathSweep.sweep` on a regular profile, then unioned with the
first piece and that with the second — the shipped `NSO_unionSoups`, the
kernel Join's union route uses, with its "the component count dropped" merge
gate. A face end paired with a point end gives up the point it was clicked at,
so a string can start on a flat face.

## Sheet (edge → edge)

A slab whose middle plane holds both edges (their ends paired so the quad does
not cross). **Thickness**: the field, or by default the thinner piece's wall —
`NSO_Thickness.measureRegion` over the faces either side of each edge — never
under **two nozzle widths** (0.8 mm at 0.4). **Flush**: when a face beside an
edge lies in the sheet's plane (within 2°), the sheet goes on the material side
of it, top flush with that face (two bars side by side: a deck flush with
their tops); otherwise it is centred on the edges. Each end runs 0.5 mm into
its piece, in the sheet's plane, and the slab is unioned as the string is.

## Guards — all before Set, in words, nothing changed

| guard | says |
|---|---|
| the web through either piece | `the band would pass through the first piece - something stands between the two faces` (the same for a string, a sheet; `the piece` when both ends are on one) |
| faces more than 60° from opposing | `the two faces are 90.0° from facing each other - a band takes faces no more than 60° from straight on; turn one piece to face the other` |
| faces facing away | `the faces face away from each other - the first face looks away from the other, so a band from it would run back through its own piece` |
| a loft that would cross itself | `the band between these faces would cross itself - the outlines are too different to loft straight across (…)` |
| a string shorter than its diameter | `the string would be 1.06 mm long, shorter than its own Ø2.0 - pick two points further apart, or a thinner string` |
| an edge with a face or a point | `one end is an edge and the other a face - a sheet runs edge to edge; …` |
| a sheet under two nozzle widths | `a 0.5 mm sheet is under two nozzle widths (0.8 mm) - the slicer would not print it as a wall` |
| two edges not in one plane | `the two edges are not in one plane (2.87 mm out of it) - a flat sheet cannot meet both; …` |
| a string leaving its surface at under 10° | `the string would pass through the first piece - from that point the line to the other one runs into the piece, not away from it` |
| paint on either piece | `Bridge stood down - N painted face(s); a bridge rebuilds both pieces into a new one. Clear paint to bridge.` |
| the weld not closed | `the welded piece would not be closed (…) - nothing changed` (pieces that arrived closed must leave closed) |

"Through either piece" is measured, not assumed: the band's triangles against
every other triangle of the welded soup near it, on one vertex grid so a weld
is never read as a crossing; the string's and sheet's exposed part (pulled
0.02 mm clear of the welded ends, and clear of the rod's rim gap and of how far
its side runs past the point at an angle) against both pieces. Every crossing
test is `NSO_Repair._triTriIntersect`, box-pruned.

## Numbers

From `tools/nso_bridge_test.js` (the drive check reproduces the ring, the
string and the sheet through the page):

| case | triangles | web | topology | measured | time |
|---|---|---|---|---|---|
| ring → oval (MINI_TPU_TEST) | 384 → 400 | band ×2 | Euler 0 | section = cut section, worst 0 mm | 13 / 28 ms |
| two boxes, 10° yaw | 12 + 12 → 28 | band | Euler 2 | largest spoke turn 1.02° | 55 ms |
| square → round | 12 + 128 → 198 | band | Euler 2 | 4/32 → 32 points, 4 walls split | 89 ms |
| two spheres, string | 960 + 960 → 2,044 | string Ø2 | Euler 2 | Ø2.000 | 351 ms |
| two bars, sheet | 12 + 12 → 46 | sheet 2 mm | Euler 2 | 2.0000 thick, top at 5.0000 | 82 ms |

Every output: closed, 2-manifold, wound one way, no degenerate faces, nothing
piercing — by `tools/mesh_validate.py` on the STL written from it.

**The ring.** MINI_TPU_TEST (Ø20 / Ø18.005, 8 tall, a 48-gon) is cut by one
plane through its axis — the Cut tool's own `rawCut` headless, the real Split
button in the drive check — which cuts the band twice: two C halves, each with
two 1.0 × 8.0 mm cut faces. The halves stand 20 mm apart and each gap is
bridged face to face. Gap 1 makes one piece (Euler 2, a C), gap 2 closes it on
itself (Euler 0, a ring again). The band's section, sliced 10 mm into the gap,
is the cut section to 0 mm (the stations are the cut faces' own vertices);
the outer perimeter goes 62.787 → 102.787 mm and the bore 56.523 → 96.523 mm —
40.000 mm each; the volume grows by the cut section × 20 mm twice
(319.041 mm³); the piece is 20 mm longer along the gap and unchanged across it.

## PAINT SCOPE: WHOLE-PIECE (both pieces)

Per `docs/HANDOFF.md`: a band drops both faces' caps and splits the walls
round them, and a string or sheet goes through the boolean kernel, which
rebuilds every face — and either way the result is a new model. No face on
either piece can be promised untouched, so any paint on either stands Bridge
down, naming the count (`nsoMaskCount(m) > 0`). In the HANDOFF roster.

## Flags — not in the ticket, or not as the ticket said

1. **"Cut TPU_TEST band twice"** is one plane through the ring's axis, which
   cuts the band in two places and leaves two halves with two gaps. A second
   plane would make four pieces and four gaps; the ticket's "+40 mm" is two
   20 mm gaps.
2. **A face end and a point end make a string.** Without it a string could
   never start on a flat face, since a flat face always picks as a face.
   Two faces are always a band; an edge with anything but an edge is refused.
3. **Two extra sheet guards**: the edges must lie in one plane (within
   0.05 mm or 1% of the shorter edge) and the quad between them must not fold
   over itself. A flat sheet cannot meet two skew edges; a twisted one is a
   curved web, out of scope.
4. **The 2-nozzle-width minimum is a floor on the field too**, not only on the
   default: a typed 0.5 mm is refused, not quietly raised.
5. **The sheet's flush rule** (above) is a choice: centred on the edges would
   leave half the sheet standing proud of two coplanar tops.
6. **A string must leave each surface at least 10° off it**; at a grazing
   angle the rod's side lies along the surface for most of its length. Said as
   "passes through the piece", the family it belongs to.
7. **Undo is `supportSwap`**, the existing two-way step (pieces off, pieces
   back), not a new undo type; `app-core.js` is unchanged.
8. **Cancel** drops the pending web and keeps the card (Repeat as often as
   wanted); with nothing pending it closes it.
9. **Where the card is**: Bend moved to the top row in shell v2, so "beside
   Extend and Bend" is the Shape drop-down's row under Extend and Mirror.
10. **The paint-scope suite** (`tools/nso_paint_scope_test.js`) is not
    extended: the ticket named the tests to run. The roster row and the source
    label are in place for it.
11. **Two faces must have the same number of outlines** (outline to outline,
    hole to hole). A ring face to a disc face is refused by name.

12. **Two clicks, not press-drag-release.** The pick used to hold the pointer
    from A to B, which froze the camera, so a B round the back of the piece
    could not be reached square-on. A is now marked by a click and stays marked
    while the view moves; only a click that does not travel (4 px) counts. A
    third click moves B rather than starting over (a click on A starts over).

## Out of scope, named

Curved webs (Bend afterwards), non-planar faces, an edge drawn freehand on a
surface, more than two targets at once.
