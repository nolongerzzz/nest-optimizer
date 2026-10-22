## Thicken in / out - one-sided planar offset (2026-09-16)

Live testing reported two things: the result of Thicken in / out was a
stepped "waffle", and Thicken in moved the outside face. Both reproduced
through the shipped buttons and the real download (open box `fixtures/
box_open.stl`, 60x40x25, 2 mm walls, open top; solid `box-20mm.stl`):

| piece, op, 1.5 mm | tris | asked | delivered | outer bbox | volume |
|---|---|---|---|---|---|
| open box, in | 68 -> 82,264 | cavity wall +1.5 | cavity wall -0.24 (thinner) | 60 -> 59.77 | 13632 -> 12104 |
| open box, out | 68 -> 90,808 | outer +1.5 | outer +1.64, cavity -1.76 | 60 -> 63.28 | 13632 -> 36789 |
| cube, in | 12 -> 33,708 | nothing | shrank 0.125 | 20 -> 19.88 | 8000 -> 7851 |
| cube, out | 12 -> 42,900 | +1.5 per side | +1.25 per side | 20 -> 22.5 | 8000 -> 11165 |

**Root cause (audit).** Thicken was a voxel dilate, not a surface offset:
rasterise into a grid capped at 110 cells per axis (pitch 0.375-0.59 mm on
these parts), flood-fill the grid border to label "exterior", grow the solid
N cells, throw the mesh away and emit a cube face per exposed voxel face.
The waffle is those cube faces; the offset is quantised to whole cells.

**Wrong-side leakage had two independent causes.** (1) Every face was
re-sampled, so the side that should be untouched was rewritten and shifted
by up to a cell - the outer face moved inward 0.12-0.23 mm on Thicken in,
and the solid cube lost 149 mm3 with nothing to thicken. (2) In/out was
decided by connectivity to the grid border, not by which side of the wall a
face is on. Any open cavity - the slot and cup shapes the code comment said
Thicken is for - read as "exterior", so Thicken in found no interior and
did nothing but the damage in (1), and Thicken out grew the cavity face too
(wall 2 mm -> 5.27 mm).

**Now** (`app-finish.js`, `_thickenOffsetSoup` and friends; header comment
carries the full rule). A face is OUTER when its plane supports the convex
hull, or is reached from one across creases shallower than 45 degrees (the
rest of a curve, a rounded edge, a knuckle's far side); everything else is
INNER. Thicken out moves the outer faces, Thicken in the inner ones, by the
intersection of offset planes at each vertex (exact up to three plane
directions, area-weighted normal push beyond that, minimum-norm on flat
faces and edges). Triangle count does not change; a held face whose
vertices touch no moving face is bit-identical. Refused, piece unchanged, no
undo pushed: no face on the asked side (Thicken in on a solid), a face that
would turn inside out (offset bigger than the feature), a rise in piercing
self-intersections (NSO_Repair's canonical count), or paint (whole-piece,
see the roster). Inner patches under 0.16 mm2 ride with the skin; slivers
(under 0.01 mm2 or thinner than 0.1 mm) get no inversion verdict, the
piercing gate still covers them. A pocket whose rim is rounded reads as
outside skin - Thicken in wants a sharp rim, which is what the box hulls
and bits have.

**Validated** (`npm run thicken:drive`, in `npm test`; every step a click,
every file the browser's download through `tools/mesh_validate.py`):
open box in 1.5 -> 68 tris, 0 open, 0 nm, Euler 2, 0 piercing, outer bbox
60x40x25 unchanged, cavity walls 2 -> 3.5, floor 2 -> 3.5, volume 22396.5
(= 60000 - 53*33*21.5); out 1.5 -> bbox 63x43x28, cavity 56 wide as before,
volume 26460. Cube out -> 23 mm, 12167. Tube (genus 1) in / out: bore or
skin only, the other within 3e-3. Sphere out 1.5 -> all 2208 vertices within
3e-4 of radius 11.5, volume ratio 1.52088 vs (11.5/10)^3. Inward-wound
`library/USB_bit.stl` still grows outward, winding kept. Hinge knuckle box:
1.5 refused (knuckle gaps), 0.3 in / out watertight with Euler -4 kept. The
tape (186 piercing pairs before anything is done to it): out 0.3 refused by
the piercing gate, in refused (rounded slot rims), download identical.
Offsets are now exact, not quantised: 1.5 asked is 1.5 delivered.
