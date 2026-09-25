# Mirror — exact reflection across one plane

`app-mirror.js`, wired into `index.html` straight after `app-extend.js`,
because the axis and the default plane come from that file and are called,
not copied.

```
node tools/nso_mirror_test.js              headless: geometry, the sequence, refusals
node tools/nso_mirror_canonical_check.js   canonical checker, then exact end identity
node tools/nso_wire_mirror_test.js         the real app, real clicks, real undo
node tools/nso_wire_mirror_orient_test.js  the piece keeps its facing: 0 degrees of turn
```

All four are in `npm test`.

## What it is

Mirror reflects a piece across a plane perpendicular to one axis. The other
two coordinates are copied bit for bit. Reflecting again returns the original
soup, coordinate for coordinate, including triangle order. A plane that cannot
do that in float32 is refused. The plane is not snapped, and an approximation
is not shipped.

The axis defaults to the piece's own dominant axis, from `NSO_extendDetectAxis`.
Whatever that function refuses — a cube, a sphere, an off-cardinal piece —
Mirror refuses, in the same words, unless `opts.axis` forces X, Y or Z.

The plane defaults to the clean-band cut from `NSO_extendBands`, the same cut
Extend would stretch through. With no clean band it falls back to the midpoint
of the extent, and says so. `opts.plane` overrides both. `0` is
X→−X (or Y→−Y, Z→−Z) and is exact.

Winding is swapped after the reflection. A mirror turns a solid inside out;
the swap puts the normals back outward, so the result is an ordinary piece:
`rawTris`, `rawAxis: 'zup'`, no mirror flag. Align and Join already know how
to read one of those.

## What it is not

Soften is not involved. Round, Bevel, Corners and Paint-exclude are a
different tool in `app-finish.js`. Mirror does not load that file, call those
functions, or share a path with them. The opposite-end sequence does not
finish each end on its own.

Align and Join are not called from this file either. They need no
Mirror-specific branch. The sequence below uses them as they stand.

## API

```
NSO_mirrorResolve(soup, opts)     -> { ok, reason, axis, axisIdx, plane, planeSource, detect, band }
NSO_mirrorRoundTrips(soup, axis, plane) -> { ok, misses, worst, example }
NSO_mirrorRaw(soup, opts)         -> { ok, reason, tris, crossSectionDrift, volumeBefore, volumeAfter, ... }
NSO_mirrorSelectedModel(opts)     -> paint check + bake + undo entry
```

`NSO_mirrorRaw` opts: `plane`, `axis`, and the detection opts `NSO_extendDetectAxis`
already takes (`maxOblique`, `tieFrac`, `offAxisDeg`). On refusal `ok` is false
and `tris` is the original soup object.

`planeSource` is `given`, `band`, or `midpoint`.

PAINT SCOPE: **WHOLE-PIECE**. Reflecting moves every vertex off the plane and
the winding swap reorders every triangle, so no face can be promised
untouched. Any paint stands the bake down. `nsoMaskCount(m)` is the whole
test. See the scoping rule in `docs/HANDOFF.md`.

## Facing: the 180-degree turn that was not Mirror's

Reported as "Mirror rotates the piece a full 180 degrees; placement is fine".
Measured through the real app on a marked, asymmetric block: the least-squares
map from the world vertices before to the world vertices after, with the
requested reflection taken out, left exactly 180.0000 degrees, about Y when
the piece had been edge-flipped (`rotY = pi`) and about X when it had been
flipped (`flipX`). An unposed piece, or one posed and mirrored directly, left
0.0000. The reflection was never the problem.

The problem was the pose record disagreeing with the mesh. Join and Subtract
draw their result at identity but kept the pose A had before on the placed
record. Mirror bakes through `NSO_sculptCommitRaw`, which honours the record
("a bake does not move the piece"), so it re-applied that stale half turn.
Seal, Solidify, Thicken, Soften, Cap and a geometry Undo had the same fault
the other way round: they drew a posed piece unposed and left the record
posed, so the next Mirror put the pose back on.

The fix is in the producers, not in Mirror. `app-core.js` has two endings for
any rebuild of a placed mesh. `nsoReseatPlacedPose` is for a bake in the
piece's own frame: the pose still stands, so it goes back on the mesh.
`nsoClearPlacedPose` is for Join and Subtract: the result is drawn at identity,
so the record is cleared to match, and Undo puts the old pose back.

`tools/nso_wire_mirror_orient_test.js` pins it: seven poses mirrored directly,
pose then Join then Mirror, Undo of Join and of Mirror, and Seal on a posed
piece then Mirror. Every case must leave 0 degrees of turn beyond the
reflection, an unmoved plate position, and a record that still describes the
mesh. On the old code it fails ten checks, each at 180 degrees.

## The opposite-end sequence

Cut at a clean band, mirror the **low** half across that plane, align, join.
No Soften step.

1. **Cut band.** `NSO_extendBands` picks the plane. `rawCut` with `keepMin`
   false keeps the material on the low side of it and caps the cut. (The clip
   in `app-cut.js` treats `keepMin` false as "keep coord ≤ plane". The low
   half is the one that matters for the next step.)

2. **Mirror** that half across the cut: `NSO_mirrorRaw(half, { axis, plane })`.
   The cap stays on the plane. The finished end lands on the high side. The
   two non-axis coordinates do not move.

3. **Align.** In raw coordinates this is the shift Join's mating search would
   apply (`NSO_fuseCandidateMatings`, the candidate on the cut axis with the
   smaller shift). For a mirror across the cut that shift is 0 — the faces
   are already flush. The plate Align button is the same idea in bed space
   and does not need to know the piece was mirrored.

4. **Join.** `NSO_findSharedFace` on those two soups, then `NSO_planarFusePair`.
   No Mirror option is passed. On a clean band the caps match with zero seam
   vertices snapped, and reflecting either end of the joined solid back across
   the cut reproduces the other end, triangle for triangle.

Why the low half, specifically. Join's parked-apart search tries the
"+ side of A" candidate first. The mirror of the low half sits on the high
side, so that first candidate is the cut, at shift 0 — the same search a
normal split already uses. Mirroring the high half instead parks the twin on
the low side, and the first candidate becomes the outer ends. On a prism those
outer ends are congruent too, so the search would join the wrong pair and
never look at the cut. That is Join's candidate order, not a flag on the piece.

`tools/nso_mirror_test.js` runs this on `library/soften_test_04_slotted_block.stl`
(a 40 mm bar with end features and a 28 mm clean span; the slot is in the
cross-section, not a reason to finish both ends by hand). Soften is not
loaded. `rawEdgeRoundInPlace` is poisoned and must not be called.

## The v8_FINAL tape

`fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl` is the complex piece
this tool was aimed at. Extend's detector calls its axis X. Extend's band scan
finds **no** clean band: 7339 gaps, the widest 2.11 mm, refused because
straddling triangles are slivers. Mirror does not weaken that scan.

Cut at the midpoint (X = 0, which is also X→−X) and the low half's mirror is
exact: reflecting it again restores the half bit for bit, and the canonical
checker's bbox has X negated with Y and Z unchanged. Join then **refuses** the
cut face on its own tolerance rail — shortest cap edge about 4e-4 mm against a
tolerance of about 1.8e-4 mm, "too coarse for this face". The cut goes through
features, which is what "no clean band" means. Join's parked-apart search, if
you let it keep looking, accepts a different pair (the outer ends, shift
−83.8 mm). The sequence does not use that pair.

So the tape confirms the mirror. It does not confirm a join, because there is
nowhere clean to cut. A bar whose finished end is separated from the rest by a
straight span — the slotted block — is the case the four steps complete.

## Cutting a Mirror-Join result again

`library/v9_mirror_factory.stl` is a Mirror-Join result. The Join's boolean
re-triangulated its seams (raw X = 87.537 and X = −88.565) into long slivers
running seam to seam across the flat faces, and left a vertex pair 7e-5 mm
apart at the +seam. The file is closed at a 1e-6 weld and fails the canonical
checker at 1e-4 (2 non-manifold edges, 5 inconsistent), before any cut.

Sequential cutting through that geometry used to break almost every piece.
It was not only the pieces that touched a seam: nearly every plane slices one
of the seam-to-seam slivers. In a 1 mm sweep over the whole part, 372 of 374
`rawCut` halves failed the checker. The cause was `rawCut` itself, not the
`-A#/-B#` veto that 86a70a2 removed: a first cut on a freshly loaded copy
never had the veto and failed the same way. The cap was welded at 1e-4 while
the walls kept the raw cut points, so cap and walls stopped sharing vertices
wherever a sliver was thinner than the weld radius at the plane. `rawCut` now
welds its input, snaps near-plane vertices onto the plane, welds and snaps
the on-plane points on their float32 positions, reads the cap edges off the
kept surface's own boundary, and splits away any zero-area triangle
(app-cut.js, comment above `RAW_CUT_WELD_TOL`). After the fix, 374 of 374
pass. So does a 16-piece sequential cut through the real app, raw and
exported. `tools/nso_rawcut_seam_test.js` (`npm run rawcut:seam`) gates the
planes that failed for each distinct reason. Run against the old `rawCut`,
23 of its gates fail.

What remains: the checker's self-intersection pass reports 1 "piercing" pair
in some mid-body pieces. Both triangles come from the Join's top-face sliver
fan. In the source they share a seam vertex, so the checker skips them as
adjacent; the cut removes that vertex. Exact rational arithmetic shows they
are disjoint: one lies in the other's plane, 9e-4 mm to its side, tilted by
about 8e-7 rad. The float Möller test in `tri_tri_intersect` misreads
near-parallel planes. That is a checker limit, not cut damage.

## UI

A **Mirror** button and a plane box in the Finish menu, Shape group, directly
under Extend. A blank box reports the detected axis and the plane it would
use, and fills the box with a decimal that `parseFloat` turns back into that
same number. `toFixed(2)` would move the cut off the exact plane and the next
click would refuse a plane the detector had just accepted. A filled box
mirrors the selected piece across that plane and replaces it in place. Clone
first, or cut first, if the original has to stay.
