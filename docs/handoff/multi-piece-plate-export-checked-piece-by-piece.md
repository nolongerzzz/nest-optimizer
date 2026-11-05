## Multi-piece plate export, checked piece by piece (2026-09-16)
`npm run export:multi` (`tools/nso_multi_export_check.js`, in `npm test`,
93 checks). The Seat-gap and Skin checks each prove one pair; this one puts
**five pieces in three independent states** on one plate through the shipped
controls and matches every exported shell to its scene piece:

- free: `box-20mm` loaded first and never touched, left where the drop put it;
- pair 1: `box_hull_80x40x20-2` + `box-20mm`, Seat (support) at -0.18;
- pair 2: `box_hull_80x40x20-2` + `box-20mm`, Skin face crosshatch, then
  Seat (support) at -0.05 (a different gap, so the two pairs cannot be
  confused in the file).

Real numbers, from the browser's actual downloads. STL through the canonical
checker `tools/mesh_validate.py --json`: 34,660 triangles (12 + 28 + 12 +
34,596 + 12, the sum of the five raw soups), 0 open, 0 non-manifold, Euler
10 (five closed shells), **0 piercing, 0 coplanar**, volume 151,728.834 =
the five raw soups to 2e-3 (2 hulls 63,360 + 3 boxes 8,000 + 1,008.834 mm³
of crosshatch relief). Split into edge-connected shells: exactly five; every
shell's X/Y extents equal the scene's world box **to 0.00e+0**, height
equal, bottom at the piece's `liftY` (0, 0, 20.18, 0, 20.650002), triangle
count and signed volume equal to the piece's own raw soup (the 34k-triangle
skinned hull lands 6e-4 mm³ off, float32). Pair gaps measured off the
shells: **0.180000** and **0.050001**; A2 20.6 tall, A1 20.0 (no skin leaked
across pairs); both bits inside their hull's footprint; smallest plan
separation between assemblies 5.000 mm, no overlap. The 3MF route: five
objects in plate order, same extents +90, gaps 0.180000 / 0.050002, every
vertex inside the 180 mm plate. Neither export moved anything in the scene
(every pose field and world box identical before and after), and a second
STL export after selecting every piece in turn is **byte-identical**
(1,733,084 bytes).

One number worth knowing, pinned rather than fixed: the scene draws a
settled piece 0.2 mm above the bed and a never-moved piece 0.3 mm above it
(`placeModelMovable`'s drop baseline vs `settlePlacedOnBed`); the export puts
both on z = 0. The 0.1 mm is in the viewport, not in the file. Seat already
settles A first for this reason ("Seat with a gap", above).
