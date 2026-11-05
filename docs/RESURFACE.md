# Resurface

Fill or repair any surface work - an engraving, a trench, a punched recess, a hole
straight through - on any mesh, however messy: the skin over the work is thrown
away and laid again, flush with the face round it. The engine is
`nso_resurface.js` (THREE-free, node-tested: `npm run resurface:test`). It is
what **Text -> Remove** runs on (docs/TEXT.md): hover a letter to light it, click
to lock it, click more to add, REMOVE fills the green (one Undo, `textReplace`).

API: `scan(soup, {point, normal}, {half})` reads the box once and returns the pieces
of work (`pieces`, `owner`, `group(id, reach)`, `pick(ids)` -> a plan for those pieces);
`pieceAt(scan, p)` which piece a point is on; `highlight(soup, scan)` the triangles of
each piece to draw; `axisAt(soup, p, r, view)` a first guess at the axis from the skin
round a point; `apply(soup, plan)` the new soup. `plan(soup, hit, opts)` is scan + a
default pick (the click's piece and what is within `reach`).

Why it exists: Remove by caps reads the recess's own floor, walls and rim, and a
scan-derived mesh (`text_repair_test.3mf`, the DUKE DOKS hand: 148,000 triangles,
splinters, self-piercing shells) has rims that fold back on themselves. Foam
fills "buried space" per layer and is exact on flat faces only. A boolean union
of a filler leaves slivers and is unreliable on a self-piercing mesh. Resurface
does not trust the work's own triangles at all.

## How it works

1. **Look down.** A ray is cast along the click's normal at every node of a grid
   (0.12 mm, a box of `half` mm each way, thinned to 160,000 nodes) through the
   shipped BVH: the height of the skin seen from above (`H`), the thickness, and
   the underside seen from below (`HB`).
2. **Find the work by its walls.** Work has walls: a drop of more than 65 degrees
   between neighbouring nodes. Cut the grid along them (two nodes thick) and what
   is left falls into pieces. The pieces that touch the box's edge or are most
   of it are the face; a piece that stands **lower than the face across a wall**
   is a pit, and with the wall round it it is the work. The click's own piece is
   tested whatever its size (a trench runs out of any box and its floor touches
   the edge). Air shut in by the piece is a hole straight through. The click's
   piece and all work within **Reach** mm of it (single linkage) are taken.
   (A first version fitted the whole box to a quadratic; a real palm is not one.)
3. **The surface to return to.** A quadratic is fitted to the ring of face round
   the work (outside two nodes of it), the mismatch at the work's edge measured
   and spread inward by Laplace's equation, so the new face meets the old with no
   step and keeps whatever slope and bumps the face had at the edge. A hole
   straight through gets the same for its underside.
2b. **The axis.** The first reading is along a guess (`axisAt`: the mean normal of the skin facing the
   viewer round the point, with the walls that face it taken out, so a letter's walls do not pull it aside).
   The walls of the pieces it finds are parallel to the axis the work was done along, so it is the direction
   least present in their normals; if that differs by more than half a degree the box is read again along
   it (up to three times). Walls that lean back under a skew axis hide from the rays - the first version
   found 8 letters from one click point and 3 or 6 from another.
4. **Replace the skin, no boolean.** Every triangle whose centroid stands in the
   footprint and within the heightfield's window (and, round a through hole, its
   wall and underside) is dropped. A shut-in patch of kept skin that small is
   work too (a splinter, a flake of old wall - a hole in the hole that no cap can
   go round) and goes with it. The rim of the hole is read as loops of the
   kept triangles' own edges. If a polygon of that rim can be ear-clipped and the result seals (every cap
   edge met by its opposite, every rim edge walked once, no cap edge joining two corners the kept skin
   already joins) `NSO_Text.capLoops` lays it, refined where the new surface stands more than 0.01 mm off
   a chord. If not - the rim of a scan is as noisy as the scan: splinters, folds a few microns deep - the
   new skin is laid on a clean outline a little inside the hole (the covered nodes, eroded 3 nodes, traced
   like a letter) and the strip between the rim and the outline is **zipped**, rim corner to outline corner by
   the shortest diagonal: a closed loop of vertices always zips, however folded, and the strip is manifold. Nothing is
   left coincident with anything, so the piece is as watertight as it was and a
   piece that pierces itself elsewhere is not asked to be a solid first.

## Results

| piece | work | result |
|---|---|---|
| flat slab | HEH-like word, 3 letters, 1 mm | volume to 0.1%, flat to 0.002 mm, app checker clean |
| flat slab | 40 x 4 x 1.5 trench | volume exact, clean |
| flat slab | hole straight through (o 8) | both faces laid, volume exact, clean |
| faceted cylinder R15 | `HEH` (the boolean's own bevels) | face back p50 0.007 / p95 0.012 / max 0.045 mm, clean, 55 ms |
| `text_repair_test.3mf` palm | 8 recesses of DUKE DOKS | filled in 0.7 s: open 0, non-manifold 0, flipped 0, flat 0; piercing pairs 2544 -> 145 (the old skin was where they were); +12.9 mm3 |

## Refused, in words

- `no pit with walls stands in this box` - a click on a plain face, on a wall, a
  direction that is not the one the work was done from.
- `the box holds almost none of the piece`, `the face under the work could not be
  fitted`, `there is no face left round the work in this box` - make the box larger.
- `the piece has an open edge under the work` - Resurface will not close a hole
  next to one.
- `the edge of the hole ... does not close into loops` / `the outline could not be
  closed` - make the box larger so the cut falls in clean face.

## Not yet

- Raised work (a boss, an embossed word): the same engine in the other
  direction - the face read from below, the ring fitted the same way.
- Smoothing as a tool of its own (a pass with no work, through a brush), and a
  card of its own with a flow-up preview: today it is Text -> Remove's fallback.
- Work whose walls are not steeper than 65 degrees (a shallow dish is a surface,
  not work: Foam / Smooth are the tools there).
